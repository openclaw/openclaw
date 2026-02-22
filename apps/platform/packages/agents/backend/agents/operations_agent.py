"""
Operations Manager Agent - Monitors infrastructure, CI/CD, and handles incidents.
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
import structlog

from .base_agent import BaseAgent
from api.models.models import Task
from integrations.github_integration import GitHubIntegration


logger = structlog.get_logger()


class OperationsManagerAgent(BaseAgent):
    """
    Operations monitoring agent for all ventures.
    
    Responsibilities:
    - Monitor server uptime and performance
    - Track CI/CD pipeline status
    - Alert on deployment failures
    - Resource utilization monitoring
    - Automated incident response
    """
    
    def __init__(self, config: Optional[Dict[str, Any]] = None, db_session=None):
        super().__init__(
            name="Operations Manager",
            agent_type="operations",
            config=config,
            db_session=db_session
        )
        
        # Initialize integrations
        self.github = GitHubIntegration()
        
        # Monitored repositories
        self.repos = self.config.get("repositories", [
            "golden-investors/family-office-os",
            "golden-investors/landing-page",
            "ras-logic/mustadem-website",
        ])
        
        # Alert thresholds
        self.thresholds = self.config.get("thresholds", {
            "pipeline_failure_threshold": 3,  # Alert after 3 consecutive failures
            "stale_pr_days": 7,               # Alert on PRs older than 7 days
            "max_open_issues": 50,            # Alert if open issues exceed 50
        })
    
    def get_capabilities(self) -> List[str]:
        """Return operations agent capabilities."""
        return [
            "monitor_ci_cd",
            "track_deployments",
            "monitor_repository_health",
            "check_open_prs",
            "check_open_issues",
            "analyze_workflow_runs",
            "check_security_alerts",
            "monitor_dependencies"
        ]
    
    async def execute(self, task: Optional[Task] = None) -> Dict[str, Any]:
        """Execute operations monitoring tasks."""
        if task:
            return await self._execute_task(task)
        
        results = {
            "repositories": {},
            "alerts": [],
            "summary": {}
        }
        
        total_open_prs = 0
        total_open_issues = 0
        failed_workflows = 0
        
        for repo in self.repos:
            self.logger.info(f"Checking repository: {repo}")
            
            repo_status = await self._check_repository(repo)
            results["repositories"][repo] = repo_status
            
            # Aggregate metrics
            total_open_prs += repo_status.get("open_prs", 0)
            total_open_issues += repo_status.get("open_issues", 0)
            if repo_status.get("latest_workflow_status") == "failure":
                failed_workflows += 1
            
            # Check for alerts
            repo_alerts = await self._check_repo_alerts(repo, repo_status)
            results["alerts"].extend(repo_alerts)
        
        results["summary"] = {
            "total_repositories": len(self.repos),
            "total_open_prs": total_open_prs,
            "total_open_issues": total_open_issues,
            "failed_workflows": failed_workflows,
            "alerts_count": len(results["alerts"]),
            "checked_at": datetime.utcnow().isoformat()
        }
        
        return results
    
    async def _execute_task(self, task: Task) -> Dict[str, Any]:
        """Execute a specific operations task."""
        task_handlers = {
            "check_repository": self._check_repository,
            "check_workflows": self._check_workflows,
            "check_prs": self._check_pull_requests,
            "check_issues": self._check_issues,
            "trigger_workflow": self._trigger_workflow,
        }
        
        handler = task_handlers.get(task.task_type)
        if handler:
            inp = task.input_data or {}
            repo = inp.get("repository")
            if task.task_type == "trigger_workflow":
                workflow_id = inp.get("workflow_id")
                return await handler(repo, workflow_id)
            if repo:
                return await handler(repo)
            return {"error": "Repository not specified"}
        
        raise ValueError(f"Unknown task type: {task.task_type}")
    
    async def _check_repository(self, repo: str) -> Dict[str, Any]:
        """Check overall repository health."""
        try:
            result = {
                "repository": repo,
                "checked_at": datetime.utcnow().isoformat(),
            }
            
            # Get repo info
            repo_info = await self.github.get_repository(repo)
            if repo_info:
                result["stars"] = repo_info.get("stargazers_count", 0)
                result["forks"] = repo_info.get("forks_count", 0)
                result["open_issues"] = repo_info.get("open_issues_count", 0)
                result["default_branch"] = repo_info.get("default_branch", "main")
                result["last_push"] = repo_info.get("pushed_at")
            
            # Get PR count
            prs = await self.github.get_pull_requests(repo, state="open")
            result["open_prs"] = len(prs) if prs else 0
            
            # Get latest workflow status
            workflows = await self.github.get_workflow_runs(repo, limit=1)
            if workflows:
                latest = workflows[0]
                result["latest_workflow_status"] = latest.get("conclusion", "unknown")
                result["latest_workflow_name"] = latest.get("name")
                result["latest_workflow_run_at"] = latest.get("created_at")
            
            return result
            
        except Exception as e:
            self.logger.error(f"Failed to check repository {repo}", error=str(e))
            return {"repository": repo, "error": str(e)}
    
    async def _check_workflows(self, repo: str) -> Dict[str, Any]:
        """Check CI/CD workflow status."""
        try:
            runs = await self.github.get_workflow_runs(repo, limit=20)
            
            # Analyze recent runs
            success = 0
            failure = 0
            in_progress = 0
            
            for run in runs or []:
                status = run.get("conclusion")
                if status == "success":
                    success += 1
                elif status == "failure":
                    failure += 1
                elif status is None:
                    in_progress += 1
            
            return {
                "repository": repo,
                "recent_runs": len(runs or []),
                "success": success,
                "failure": failure,
                "in_progress": in_progress,
                "success_rate": success / len(runs) if runs else 0,
                "runs": runs[:5] if runs else []  # Return last 5 runs
            }
            
        except Exception as e:
            self.logger.error(f"Failed to check workflows for {repo}", error=str(e))
            return {"repository": repo, "error": str(e)}
    
    async def _check_pull_requests(self, repo: str) -> Dict[str, Any]:
        """Check open pull requests."""
        try:
            prs = await self.github.get_pull_requests(repo, state="open")
            
            stale_prs = []
            for pr in prs or []:
                created = pr.get("created_at", "")
                if created:
                    created_date = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    age_days = (datetime.now(created_date.tzinfo) - created_date).days
                    pr["age_days"] = age_days
                    if age_days > self.thresholds["stale_pr_days"]:
                        stale_prs.append(pr)
            
            return {
                "repository": repo,
                "total_open": len(prs or []),
                "stale_count": len(stale_prs),
                "stale_prs": stale_prs,
                "all_prs": prs
            }
            
        except Exception as e:
            self.logger.error(f"Failed to check PRs for {repo}", error=str(e))
            return {"repository": repo, "error": str(e)}
    
    async def _check_issues(self, repo: str) -> Dict[str, Any]:
        """Check open issues."""
        try:
            issues = await self.github.get_issues(repo, state="open")
            
            # Categorize by labels
            by_label = {}
            for issue in issues or []:
                labels = [l.get("name") for l in issue.get("labels", [])]
                for label in labels:
                    if label not in by_label:
                        by_label[label] = []
                    by_label[label].append(issue)
            
            return {
                "repository": repo,
                "total_open": len(issues or []),
                "by_label": {k: len(v) for k, v in by_label.items()},
                "recent_issues": issues[:10] if issues else []
            }
            
        except Exception as e:
            self.logger.error(f"Failed to check issues for {repo}", error=str(e))
            return {"repository": repo, "error": str(e)}
    
    async def _trigger_workflow(self, repo: str, workflow_id: Optional[str] = None) -> Dict[str, Any]:
        """Trigger a workflow run."""
        try:
            result = await self.github.trigger_workflow(repo, workflow_id)
            return {
                "repository": repo,
                "workflow_id": workflow_id,
                "triggered": True,
                "result": result
            }
        except Exception as e:
            self.logger.error(f"Failed to trigger workflow for {repo}", error=str(e))
            return {"repository": repo, "error": str(e), "triggered": False}
    
    async def _check_repo_alerts(
        self,
        repo: str,
        status: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Check for alert conditions in a repository."""
        alerts = []
        
        # Check workflow failures
        if status.get("latest_workflow_status") == "failure":
            alerts.append({
                "type": "workflow_failure",
                "severity": "critical",
                "repository": repo,
                "message": f"Latest workflow failed in {repo}",
                "data": {
                    "workflow": status.get("latest_workflow_name"),
                    "run_at": status.get("latest_workflow_run_at")
                }
            })
        
        # Check stale PRs
        open_prs = status.get("open_prs", 0)
        if open_prs > 10:
            alerts.append({
                "type": "too_many_open_prs",
                "severity": "warning",
                "repository": repo,
                "message": f"{open_prs} open PRs in {repo}",
                "data": {"count": open_prs}
            })
        
        # Check open issues
        open_issues = status.get("open_issues", 0)
        if open_issues > self.thresholds["max_open_issues"]:
            alerts.append({
                "type": "too_many_issues",
                "severity": "warning",
                "repository": repo,
                "message": f"{open_issues} open issues in {repo}",
                "data": {"count": open_issues}
            })
        
        return alerts
    
    async def health_check(self) -> Dict[str, Any]:
        """Check operations agent health."""
        health = {
            "agent": self.name,
            "status": "healthy",
            "integrations": {}
        }
        
        # Check GitHub connection
        try:
            rate_limit = await self.github.get_rate_limit()
            health["integrations"]["github"] = {
                "status": "connected",
                "rate_limit_remaining": rate_limit.get("remaining") if rate_limit else None
            }
        except Exception as e:
            health["integrations"]["github"] = {
                "status": "error",
                "error": str(e)
            }
            health["status"] = "degraded"
        
        return health
