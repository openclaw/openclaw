"""
Finance Monitor Agent - Tracks financial transactions, bank accounts, and generates reports.
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
import structlog

from .base_agent import BaseAgent
from api.models.models import Task
from integrations.stripe_integration import StripeIntegration


logger = structlog.get_logger()


class FinanceMonitorAgent(BaseAgent):
    """
    Finance monitoring agent for Golden Investors and other ventures.
    
    Responsibilities:
    - Track Stripe transactions
    - Monitor bank accounts via Open Banking
    - Generate financial reports
    - Alert on unusual transactions
    - Budget tracking and forecasting
    """
    
    def __init__(self, config: Optional[Dict[str, Any]] = None, db_session=None):
        super().__init__(
            name="Finance Monitor",
            agent_type="finance",
            config=config,
            db_session=db_session
        )
        
        # Initialize integrations
        self.stripe = StripeIntegration()
        
        # Alert thresholds
        self.alert_thresholds = self.config.get("alert_thresholds", {
            "large_transaction": 10000,  # Alert on transactions > £10,000
            "daily_volume": 100000,       # Alert if daily volume exceeds £100,000
            "failed_payment_rate": 0.05,  # Alert if failure rate > 5%
        })
    
    def get_capabilities(self) -> List[str]:
        """Return finance agent capabilities."""
        return [
            "track_stripe_transactions",
            "monitor_bank_accounts",
            "generate_financial_report",
            "detect_unusual_transactions",
            "budget_tracking",
            "revenue_forecasting",
            "expense_categorization",
            "invoice_monitoring"
        ]
    
    async def execute(self, task: Optional[Task] = None) -> Dict[str, Any]:
        """
        Execute finance monitoring tasks.
        """
        if task:
            return await self._execute_task(task)
        
        # Default: run all monitoring tasks
        results = {}
        
        # 1. Check recent transactions
        self.logger.info("Checking recent transactions")
        transactions = await self._check_transactions()
        results["transactions"] = transactions
        
        # 2. Calculate daily metrics
        self.logger.info("Calculating daily metrics")
        metrics = await self._calculate_daily_metrics()
        results["metrics"] = metrics
        
        # 3. Check for alerts
        self.logger.info("Checking for alerts")
        alerts = await self._check_alerts(transactions, metrics)
        results["alerts"] = alerts
        
        # 4. Generate summary
        results["summary"] = {
            "transactions_processed": len(transactions.get("items", [])),
            "total_revenue": metrics.get("total_revenue", 0),
            "alerts_generated": len(alerts),
            "timestamp": datetime.utcnow().isoformat()
        }
        
        return results
    
    async def _execute_task(self, task: Task) -> Dict[str, Any]:
        """Execute a specific task."""
        task_handlers = {
            "generate_report": self._generate_financial_report,
            "check_transactions": self._check_transactions,
            "analyze_revenue": self._analyze_revenue,
            "forecast": self._generate_forecast,
        }
        
        handler = task_handlers.get(task.task_type)
        if handler:
            return await handler(task.input_data)
        
        raise ValueError(f"Unknown task type: {task.task_type}")
    
    async def _check_transactions(self, params: Optional[Dict] = None) -> Dict[str, Any]:
        """Check recent Stripe transactions."""
        try:
            days = (params or {}).get("days", 1)
            since = datetime.utcnow() - timedelta(days=days)
            
            transactions = await self.stripe.get_transactions(
                created_after=since,
                limit=100
            )
            
            # Categorize transactions
            categorized = {
                "successful": [],
                "failed": [],
                "pending": [],
                "refunded": []
            }
            
            total_amount = 0
            for txn in transactions:
                status = txn.get("status", "unknown")
                if status in categorized:
                    categorized[status].append(txn)
                if status == "successful":
                    total_amount += txn.get("amount", 0)
            
            return {
                "items": transactions,
                "categorized": categorized,
                "total_amount": total_amount,
                "period_days": days
            }
            
        except Exception as e:
            self.logger.error("Failed to check transactions", error=str(e))
            return {"error": str(e), "items": []}
    
    async def _calculate_daily_metrics(self) -> Dict[str, Any]:
        """Calculate daily financial metrics."""
        try:
            # Get today's data
            today = datetime.utcnow().date()
            
            metrics = {
                "date": today.isoformat(),
                "total_revenue": 0,
                "transaction_count": 0,
                "average_transaction": 0,
                "refund_amount": 0,
                "net_revenue": 0,
                "payment_success_rate": 0,
            }
            
            # Fetch from Stripe
            balance = await self.stripe.get_balance()
            if balance:
                metrics["available_balance"] = balance.get("available", 0)
                metrics["pending_balance"] = balance.get("pending", 0)
            
            # Calculate from transactions
            txns = await self._check_transactions({"days": 1})
            if txns.get("items"):
                successful = txns["categorized"]["successful"]
                failed = txns["categorized"]["failed"]
                refunded = txns["categorized"]["refunded"]
                
                metrics["total_revenue"] = sum(t.get("amount", 0) for t in successful)
                metrics["transaction_count"] = len(successful)
                metrics["refund_amount"] = sum(t.get("amount", 0) for t in refunded)
                metrics["net_revenue"] = metrics["total_revenue"] - metrics["refund_amount"]
                
                if metrics["transaction_count"] > 0:
                    metrics["average_transaction"] = metrics["total_revenue"] / metrics["transaction_count"]
                
                total_attempts = len(successful) + len(failed)
                if total_attempts > 0:
                    metrics["payment_success_rate"] = len(successful) / total_attempts
            
            return metrics
            
        except Exception as e:
            self.logger.error("Failed to calculate metrics", error=str(e))
            return {"error": str(e)}
    
    async def _check_alerts(
        self,
        transactions: Dict[str, Any],
        metrics: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Check for conditions that should trigger alerts."""
        alerts = []
        
        # Check for large transactions
        threshold = self.alert_thresholds["large_transaction"]
        for txn in transactions.get("items", []):
            if txn.get("amount", 0) >= threshold:
                alerts.append({
                    "type": "large_transaction",
                    "severity": "warning",
                    "message": f"Large transaction detected: £{txn['amount']/100:.2f}",
                    "data": txn
                })
        
        # Check daily volume
        if metrics.get("total_revenue", 0) >= self.alert_thresholds["daily_volume"]:
            alerts.append({
                "type": "high_volume",
                "severity": "info",
                "message": f"High daily volume: £{metrics['total_revenue']/100:.2f}",
                "data": metrics
            })
        
        # Check failure rate
        success_rate = metrics.get("payment_success_rate", 1)
        if success_rate < (1 - self.alert_thresholds["failed_payment_rate"]):
            alerts.append({
                "type": "high_failure_rate",
                "severity": "critical",
                "message": f"High payment failure rate: {(1-success_rate)*100:.1f}%",
                "data": {"success_rate": success_rate}
            })
        
        return alerts
    
    async def _generate_financial_report(self, params: Dict) -> Dict[str, Any]:
        """Generate a financial report for a given period."""
        period = params.get("period", "daily")
        
        # Determine date range
        if period == "daily":
            days = 1
        elif period == "weekly":
            days = 7
        elif period == "monthly":
            days = 30
        else:
            days = int(params.get("days", 7))
        
        transactions = await self._check_transactions({"days": days})
        
        report = {
            "period": period,
            "days": days,
            "generated_at": datetime.utcnow().isoformat(),
            "summary": {
                "total_transactions": len(transactions.get("items", [])),
                "successful": len(transactions["categorized"]["successful"]),
                "failed": len(transactions["categorized"]["failed"]),
                "refunded": len(transactions["categorized"]["refunded"]),
            },
            "financials": {
                "gross_revenue": sum(t.get("amount", 0) for t in transactions["categorized"]["successful"]),
                "refunds": sum(t.get("amount", 0) for t in transactions["categorized"]["refunded"]),
            }
        }
        
        report["financials"]["net_revenue"] = (
            report["financials"]["gross_revenue"] - 
            report["financials"]["refunds"]
        )
        
        return report
    
    async def _analyze_revenue(self, params: Dict) -> Dict[str, Any]:
        """Analyze revenue patterns and trends."""
        days = params.get("days", 30)
        transactions = await self._check_transactions({"days": days})
        
        # Group by day
        daily_revenue = {}
        for txn in transactions["categorized"]["successful"]:
            date = txn.get("created", "")[:10]  # Extract date
            if date not in daily_revenue:
                daily_revenue[date] = 0
            daily_revenue[date] += txn.get("amount", 0)
        
        return {
            "period_days": days,
            "daily_revenue": daily_revenue,
            "total": sum(daily_revenue.values()),
            "average_daily": sum(daily_revenue.values()) / max(len(daily_revenue), 1)
        }
    
    async def _generate_forecast(self, params: Dict) -> Dict[str, Any]:
        """Generate revenue forecast based on historical data."""
        # Get historical data
        historical = await self._analyze_revenue({"days": 90})
        
        avg_daily = historical.get("average_daily", 0)
        
        return {
            "based_on_days": 90,
            "average_daily_revenue": avg_daily,
            "forecast": {
                "7_day": avg_daily * 7,
                "30_day": avg_daily * 30,
                "90_day": avg_daily * 90,
            },
            "confidence": "low" if avg_daily == 0 else "medium",
            "generated_at": datetime.utcnow().isoformat()
        }
    
    async def health_check(self) -> Dict[str, Any]:
        """Check finance agent health and integrations."""
        health = {
            "agent": self.name,
            "status": "healthy",
            "integrations": {}
        }
        
        # Check Stripe connection
        try:
            balance = await self.stripe.get_balance()
            health["integrations"]["stripe"] = {
                "status": "connected" if balance else "error",
                "has_balance": balance is not None
            }
        except Exception as e:
            health["integrations"]["stripe"] = {
                "status": "error",
                "error": str(e)
            }
            health["status"] = "degraded"
        
        return health
