"""
GitHub Integration - Repository monitoring, CI/CD, and issue tracking.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
import structlog

from .base_integration import BaseIntegration
from core.config import settings


logger = structlog.get_logger()


class GitHubIntegration(BaseIntegration):
    """
    GitHub API integration for repository monitoring.
    
    Features:
    - Repository status and metrics
    - Pull request tracking
    - Issue management
    - Workflow/CI status
    - Commit history
    """
    
    def __init__(self, token: Optional[str] = None):
        super().__init__(
            name="GitHub",
            base_url="https://api.github.com",
            timeout=30.0
        )
        self.token = token or settings.github_token
    
    def _get_default_headers(self) -> Dict[str, str]:
        """Return GitHub API headers."""
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers
    
    async def health_check(self) -> Dict[str, Any]:
        """Check GitHub API connection."""
        try:
            rate_limit = await self.get_rate_limit()
            return {
                "status": "connected",
                "rate_limit": rate_limit
            }
        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }
    
    async def get_rate_limit(self) -> Dict[str, Any]:
        """Get current rate limit status."""
        try:
            response = await self.get("/rate_limit")
            return response.get("rate", {})
        except Exception as e:
            self.logger.error("Failed to get rate limit", error=str(e))
            return {}
    
    async def get_repository(self, repo: str) -> Optional[Dict[str, Any]]:
        """
        Get repository information.
        
        Args:
            repo: Repository in format "owner/repo"
        """
        try:
            return await self.get(f"/repos/{repo}")
        except Exception as e:
            self.logger.error(f"Failed to get repository {repo}", error=str(e))
            return None
    
    async def get_pull_requests(
        self,
        repo: str,
        state: str = "open",
        limit: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Get pull requests for a repository.
        
        Args:
            repo: Repository in format "owner/repo"
            state: PR state (open, closed, all)
            limit: Maximum number of PRs to return
        """
        try:
            response = await self.get(
                f"/repos/{repo}/pulls",
                params={"state": state, "per_page": limit}
            )
            return response if isinstance(response, list) else []
        except Exception as e:
            self.logger.error(f"Failed to get PRs for {repo}", error=str(e))
            return []
    
    async def get_issues(
        self,
        repo: str,
        state: str = "open",
        limit: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Get issues for a repository.
        
        Args:
            repo: Repository in format "owner/repo"
            state: Issue state (open, closed, all)
            limit: Maximum number of issues
        """
        try:
            response = await self.get(
                f"/repos/{repo}/issues",
                params={"state": state, "per_page": limit}
            )
            # Filter out PRs (they show up as issues too)
            return [i for i in response if "pull_request" not in i] if isinstance(response, list) else []
        except Exception as e:
            self.logger.error(f"Failed to get issues for {repo}", error=str(e))
            return []
    
    async def get_workflow_runs(
        self,
        repo: str,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Get workflow runs (CI/CD) for a repository.
        
        Args:
            repo: Repository in format "owner/repo"
            limit: Maximum number of runs
        """
        try:
            response = await self.get(
                f"/repos/{repo}/actions/runs",
                params={"per_page": limit}
            )
            return response.get("workflow_runs", [])
        except Exception as e:
            self.logger.error(f"Failed to get workflows for {repo}", error=str(e))
            return []
    
    async def get_commits(
        self,
        repo: str,
        branch: str = None,
        since: datetime = None,
        limit: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Get commits for a repository.
        
        Args:
            repo: Repository in format "owner/repo"
            branch: Branch name (optional)
            since: Only commits after this date
            limit: Maximum number of commits
        """
        try:
            params = {"per_page": limit}
            if branch:
                params["sha"] = branch
            if since:
                params["since"] = since.isoformat()
            
            response = await self.get(f"/repos/{repo}/commits", params=params)
            return response if isinstance(response, list) else []
        except Exception as e:
            self.logger.error(f"Failed to get commits for {repo}", error=str(e))
            return []
    
    async def get_branches(self, repo: str) -> List[Dict[str, Any]]:
        """Get branches for a repository."""
        try:
            response = await self.get(f"/repos/{repo}/branches")
            return response if isinstance(response, list) else []
        except Exception as e:
            self.logger.error(f"Failed to get branches for {repo}", error=str(e))
            return []
    
    async def trigger_workflow(
        self,
        repo: str,
        workflow_id: str,
        ref: str = "main",
        inputs: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Trigger a workflow dispatch event.
        
        Args:
            repo: Repository in format "owner/repo"
            workflow_id: Workflow file name or ID
            ref: Branch to run on
            inputs: Workflow inputs
        """
        try:
            payload = {"ref": ref}
            if inputs:
                payload["inputs"] = inputs
            
            return await self.post(
                f"/repos/{repo}/actions/workflows/{workflow_id}/dispatches",
                json=payload
            )
        except Exception as e:
            self.logger.error(f"Failed to trigger workflow {workflow_id}", error=str(e))
            raise
    
    async def create_issue(
        self,
        repo: str,
        title: str,
        body: str,
        labels: List[str] = None
    ) -> Dict[str, Any]:
        """
        Create a new issue.
        
        Args:
            repo: Repository in format "owner/repo"
            title: Issue title
            body: Issue body
            labels: List of label names
        """
        try:
            payload = {"title": title, "body": body}
            if labels:
                payload["labels"] = labels
            
            return await self.post(f"/repos/{repo}/issues", json=payload)
        except Exception as e:
            self.logger.error(f"Failed to create issue in {repo}", error=str(e))
            raise
    
    async def get_org_repos(
        self,
        org: str = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get repositories for an organization.
        
        Args:
            org: Organization name (defaults to settings)
            limit: Maximum number of repos
        """
        org = org or settings.github_org
        try:
            response = await self.get(
                f"/orgs/{org}/repos",
                params={"per_page": limit, "sort": "updated"}
            )
            return response if isinstance(response, list) else []
        except Exception as e:
            self.logger.error(f"Failed to get repos for org {org}", error=str(e))
            return []
    
    async def get_user_repos(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Get repositories for authenticated user."""
        try:
            response = await self.get(
                "/user/repos",
                params={"per_page": limit, "sort": "updated"}
            )
            return response if isinstance(response, list) else []
        except Exception as e:
            self.logger.error("Failed to get user repos", error=str(e))
            return []
