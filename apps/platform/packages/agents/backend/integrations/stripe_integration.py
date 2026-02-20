"""
Stripe Integration - Payment processing and financial monitoring.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
import structlog

from .base_integration import BaseIntegration
from core.config import settings


logger = structlog.get_logger()


class StripeIntegration(BaseIntegration):
    """
    Stripe API integration for payment monitoring.
    
    Features:
    - Transaction tracking
    - Balance monitoring
    - Customer management
    - Subscription analytics
    - Refund tracking
    """
    
    def __init__(self, api_key: Optional[str] = None):
        super().__init__(
            name="Stripe",
            base_url="https://api.stripe.com/v1",
            timeout=30.0
        )
        self.api_key = api_key or settings.stripe_api_key
    
    def _get_default_headers(self) -> Dict[str, str]:
        """Return Stripe API headers."""
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers
    
    async def health_check(self) -> Dict[str, Any]:
        """Check Stripe API connection."""
        try:
            balance = await self.get_balance()
            return {
                "status": "connected",
                "has_balance": balance is not None
            }
        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }
    
    async def get_balance(self) -> Optional[Dict[str, Any]]:
        """Get current Stripe balance."""
        try:
            response = await self.get("/balance")
            
            # Parse balance by currency
            available = {}
            pending = {}
            
            for item in response.get("available", []):
                currency = item.get("currency", "gbp")
                available[currency] = item.get("amount", 0)
            
            for item in response.get("pending", []):
                currency = item.get("currency", "gbp")
                pending[currency] = item.get("amount", 0)
            
            return {
                "available": available,
                "pending": pending,
                "livemode": response.get("livemode", False)
            }
        except Exception as e:
            self.logger.error("Failed to get balance", error=str(e))
            return None
    
    async def get_transactions(
        self,
        created_after: datetime = None,
        created_before: datetime = None,
        limit: int = 100,
        type_filter: str = None
    ) -> List[Dict[str, Any]]:
        """
        Get balance transactions.
        
        Args:
            created_after: Only transactions after this date
            created_before: Only transactions before this date
            limit: Maximum number of transactions
            type_filter: Filter by type (charge, refund, payout, etc.)
        """
        try:
            params = {"limit": limit}
            
            if created_after:
                params["created[gte]"] = int(created_after.timestamp())
            if created_before:
                params["created[lte]"] = int(created_before.timestamp())
            if type_filter:
                params["type"] = type_filter
            
            response = await self.get("/balance_transactions", params=params)
            transactions = response.get("data", [])
            
            # Normalize transaction data
            normalized = []
            for txn in transactions:
                normalized.append({
                    "id": txn.get("id"),
                    "amount": txn.get("amount", 0),
                    "currency": txn.get("currency", "gbp"),
                    "type": txn.get("type"),
                    "status": txn.get("status"),
                    "description": txn.get("description"),
                    "created": datetime.fromtimestamp(txn.get("created", 0)).isoformat(),
                    "fee": txn.get("fee", 0),
                    "net": txn.get("net", 0),
                })
            
            return normalized
        except Exception as e:
            self.logger.error("Failed to get transactions", error=str(e))
            return []
    
    async def get_charges(
        self,
        created_after: datetime = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get payment charges.
        
        Args:
            created_after: Only charges after this date
            limit: Maximum number of charges
        """
        try:
            params = {"limit": limit}
            if created_after:
                params["created[gte]"] = int(created_after.timestamp())
            
            response = await self.get("/charges", params=params)
            return response.get("data", [])
        except Exception as e:
            self.logger.error("Failed to get charges", error=str(e))
            return []
    
    async def get_refunds(
        self,
        created_after: datetime = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Get refunds."""
        try:
            params = {"limit": limit}
            if created_after:
                params["created[gte]"] = int(created_after.timestamp())
            
            response = await self.get("/refunds", params=params)
            return response.get("data", [])
        except Exception as e:
            self.logger.error("Failed to get refunds", error=str(e))
            return []
    
    async def get_customers(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Get customer list."""
        try:
            response = await self.get("/customers", params={"limit": limit})
            return response.get("data", [])
        except Exception as e:
            self.logger.error("Failed to get customers", error=str(e))
            return []
    
    async def get_subscriptions(
        self,
        status: str = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get subscriptions.
        
        Args:
            status: Filter by status (active, past_due, canceled, etc.)
            limit: Maximum number of subscriptions
        """
        try:
            params = {"limit": limit}
            if status:
                params["status"] = status
            
            response = await self.get("/subscriptions", params=params)
            return response.get("data", [])
        except Exception as e:
            self.logger.error("Failed to get subscriptions", error=str(e))
            return []
    
    async def get_payouts(
        self,
        created_after: datetime = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Get payouts to bank account."""
        try:
            params = {"limit": limit}
            if created_after:
                params["created[gte]"] = int(created_after.timestamp())
            
            response = await self.get("/payouts", params=params)
            return response.get("data", [])
        except Exception as e:
            self.logger.error("Failed to get payouts", error=str(e))
            return []
    
    async def get_revenue_metrics(self, days: int = 30) -> Dict[str, Any]:
        """
        Calculate revenue metrics for a period.
        
        Args:
            days: Number of days to analyze
        """
        try:
            since = datetime.utcnow() - timedelta(days=days)
            transactions = await self.get_transactions(created_after=since, limit=500)
            
            total_revenue = 0
            total_fees = 0
            total_refunds = 0
            charge_count = 0
            refund_count = 0
            
            for txn in transactions:
                if txn["type"] == "charge":
                    total_revenue += txn["amount"]
                    total_fees += txn["fee"]
                    charge_count += 1
                elif txn["type"] == "refund":
                    total_refunds += abs(txn["amount"])
                    refund_count += 1
            
            return {
                "period_days": days,
                "total_revenue": total_revenue,
                "total_fees": total_fees,
                "total_refunds": total_refunds,
                "net_revenue": total_revenue - total_fees - total_refunds,
                "charge_count": charge_count,
                "refund_count": refund_count,
                "average_charge": total_revenue / charge_count if charge_count > 0 else 0,
                "refund_rate": refund_count / charge_count if charge_count > 0 else 0
            }
        except Exception as e:
            self.logger.error("Failed to calculate revenue metrics", error=str(e))
            return {"error": str(e)}
    
    async def get_subscription_metrics(self) -> Dict[str, Any]:
        """Get subscription analytics."""
        try:
            active = await self.get_subscriptions(status="active")
            past_due = await self.get_subscriptions(status="past_due")
            canceled = await self.get_subscriptions(status="canceled", limit=30)
            
            # Calculate MRR
            mrr = 0
            for sub in active:
                plan = sub.get("plan", {})
                amount = plan.get("amount", 0)
                interval = plan.get("interval", "month")
                
                # Normalize to monthly
                if interval == "year":
                    mrr += amount / 12
                else:
                    mrr += amount
            
            return {
                "active_subscriptions": len(active),
                "past_due_subscriptions": len(past_due),
                "recently_canceled": len(canceled),
                "mrr": mrr,
                "arr": mrr * 12
            }
        except Exception as e:
            self.logger.error("Failed to get subscription metrics", error=str(e))
            return {"error": str(e)}
