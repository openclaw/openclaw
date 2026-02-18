#!/usr/bin/env python3
"""
Linear CLI - Interact with Linear API via GraphQL

Usage:
    linear.py create --title "..." --description "..." [--project PROJECT] [--priority PRIORITY]
    linear.py update ISSUE_ID [--status STATUS] [--assignee @me|email] [--title TITLE] [--priority PRIORITY]
    linear.py query [--project PROJECT] [--status STATUS] [--assignee @me|email] [--limit N]
    linear.py comment ISSUE_ID "comment text"
    linear.py link ISSUE_ID --url URL [--title TITLE]
    linear.py show ISSUE_ID

Environment:
    LINEAR_API_KEY - Required. Get from https://linear.app/settings/api
"""

import os
import sys
import json
import argparse
from typing import Optional, Dict, Any
import urllib.request
import urllib.error

LINEAR_API_URL = "https://api.linear.app/graphql"

def get_api_key() -> str:
    """Get Linear API key from environment."""
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        print("Error: LINEAR_API_KEY environment variable not set", file=sys.stderr)
        print("Get your API key from https://linear.app/settings/api", file=sys.stderr)
        sys.exit(1)
    return api_key

def graphql_request(query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Execute GraphQL request against Linear API."""
    api_key = get_api_key()
    
    headers = {
        "Authorization": api_key,
        "Content-Type": "application/json",
    }
    
    data = {"query": query}
    if variables:
        data["variables"] = variables
    
    req = urllib.request.Request(
        LINEAR_API_URL,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            if "errors" in result:
                print(f"GraphQL errors: {json.dumps(result['errors'], indent=2)}", file=sys.stderr)
                sys.exit(1)
            return result.get("data", {})
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}", file=sys.stderr)
        sys.exit(1)

def get_team_id(project_key: str) -> str:
    """Get team ID from project key (e.g., STX -> team ID)."""
    query = """
    query Teams {
        teams {
            nodes {
                id
                key
                name
            }
        }
    }
    """
    result = graphql_request(query)
    teams = result.get("teams", {}).get("nodes", [])
    
    for team in teams:
        if team["key"] == project_key:
            return team["id"]
    
    print(f"Error: Team/project '{project_key}' not found", file=sys.stderr)
    print(f"Available teams: {', '.join(t['key'] for t in teams)}", file=sys.stderr)
    sys.exit(1)

def get_viewer_id() -> str:
    """Get current user's ID."""
    query = """
    query Viewer {
        viewer {
            id
            email
        }
    }
    """
    result = graphql_request(query)
    return result["viewer"]["id"]

def create_issue(title: str, description: str, project: Optional[str] = None, 
                 priority: Optional[int] = None) -> Dict[str, Any]:
    """Create a new Linear issue."""
    mutation = """
    mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
            success
            issue {
                id
                identifier
                title
                url
            }
        }
    }
    """
    
    input_data = {
        "title": title,
        "description": description,
    }
    
    if project:
        input_data["teamId"] = get_team_id(project)
    
    if priority is not None:
        # Linear priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
        input_data["priority"] = priority
    
    result = graphql_request(mutation, {"input": input_data})
    
    if result["issueCreate"]["success"]:
        issue = result["issueCreate"]["issue"]
        print(f"✓ Created {issue['identifier']}: {issue['title']}")
        print(f"  URL: {issue['url']}")
        return issue
    else:
        print("Error: Failed to create issue", file=sys.stderr)
        sys.exit(1)

def update_issue(issue_id: str, status: Optional[str] = None, assignee: Optional[str] = None,
                 title: Optional[str] = None, priority: Optional[int] = None) -> None:
    """Update an existing Linear issue."""
    # First resolve the issue identifier to ID
    query = """
    query Issue($id: String!) {
        issue(id: $id) {
            id
            identifier
        }
    }
    """
    result = graphql_request(query, {"id": issue_id})
    internal_id = result["issue"]["id"]
    
    mutation = """
    mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
            success
            issue {
                identifier
                title
            }
        }
    }
    """
    
    input_data = {}
    
    if title:
        input_data["title"] = title
    
    if priority is not None:
        # Linear priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
        input_data["priority"] = priority
    
    if status:
        # Get workflow states for the team
        state_query = """
        query Issue($id: String!) {
            issue(id: $id) {
                team {
                    states {
                        nodes {
                            id
                            name
                        }
                    }
                }
            }
        }
        """
        state_result = graphql_request(state_query, {"id": issue_id})
        states = state_result["issue"]["team"]["states"]["nodes"]
        
        # Find matching state (case-insensitive)
        state_id = None
        for state in states:
            if state["name"].lower() == status.lower():
                state_id = state["id"]
                break
        
        if not state_id:
            print(f"Error: Status '{status}' not found", file=sys.stderr)
            print(f"Available statuses: {', '.join(s['name'] for s in states)}", file=sys.stderr)
            sys.exit(1)
        
        input_data["stateId"] = state_id
    
    if assignee:
        if assignee == "@me":
            input_data["assigneeId"] = get_viewer_id()
        else:
            # Lookup user by email
            user_query = """
            query Users {
                users {
                    nodes {
                        id
                        email
                    }
                }
            }
            """
            user_result = graphql_request(user_query)
            users = user_result["users"]["nodes"]
            
            user_id = None
            for user in users:
                if user["email"] == assignee:
                    user_id = user["id"]
                    break
            
            if not user_id:
                print(f"Error: User '{assignee}' not found", file=sys.stderr)
                sys.exit(1)
            
            input_data["assigneeId"] = user_id
    
    result = graphql_request(mutation, {"id": internal_id, "input": input_data})
    
    if result["issueUpdate"]["success"]:
        issue = result["issueUpdate"]["issue"]
        print(f"✓ Updated {issue['identifier']}")
    else:
        print("Error: Failed to update issue", file=sys.stderr)
        sys.exit(1)

def query_issues(project: Optional[str] = None, status: Optional[str] = None, 
                 assignee: Optional[str] = None, limit: int = 10) -> None:
    """Query Linear issues with filters."""
    query = """
    query Issues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first) {
            nodes {
                identifier
                title
                state {
                    name
                }
                assignee {
                    email
                }
                priority
                url
            }
        }
    }
    """
    
    filter_data = {}
    
    if project:
        team_id = get_team_id(project)
        filter_data["team"] = {"id": {"eq": team_id}}
    
    if status:
        filter_data["state"] = {"name": {"eq": status}}
    
    if assignee:
        if assignee == "@me":
            filter_data["assignee"] = {"id": {"eq": get_viewer_id()}}
        else:
            # Would need to lookup user ID by email (omitted for brevity)
            pass
    
    result = graphql_request(query, {"filter": filter_data or None, "first": limit})
    issues = result["issues"]["nodes"]
    
    if not issues:
        print("No issues found")
        return
    
    for issue in issues:
        assignee_email = issue["assignee"]["email"] if issue["assignee"] else "Unassigned"
        priority_map = {0: "None", 1: "🔴 Urgent", 2: "🟠 High", 3: "🟡 Medium", 4: "⚪ Low"}
        priority_str = priority_map.get(issue["priority"], "None")
        
        print(f"{issue['identifier']}: {issue['title']}")
        print(f"  Status: {issue['state']['name']} | Assignee: {assignee_email} | Priority: {priority_str}")
        print(f"  {issue['url']}")
        print()

def add_comment(issue_id: str, body: str) -> None:
    """Add a comment to an issue."""
    # Resolve identifier to ID
    query = """
    query Issue($id: String!) {
        issue(id: $id) {
            id
        }
    }
    """
    result = graphql_request(query, {"id": issue_id})
    internal_id = result["issue"]["id"]
    
    mutation = """
    mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
            success
            comment {
                id
            }
        }
    }
    """
    
    result = graphql_request(mutation, {"input": {"issueId": internal_id, "body": body}})
    
    if result["commentCreate"]["success"]:
        print(f"✓ Added comment to {issue_id}")
    else:
        print("Error: Failed to add comment", file=sys.stderr)
        sys.exit(1)

def link_url(issue_id: str, url: str, title: Optional[str] = None) -> None:
    """Attach a URL to an issue."""
    query = """
    query Issue($id: String!) {
        issue(id: $id) {
            id
        }
    }
    """
    result = graphql_request(query, {"id": issue_id})
    internal_id = result["issue"]["id"]
    
    mutation = """
    mutation AttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
            success
            attachment {
                id
            }
        }
    }
    """
    
    input_data = {
        "issueId": internal_id,
        "url": url,
    }
    
    if title:
        input_data["title"] = title
    
    result = graphql_request(mutation, {"input": input_data})
    
    if result["attachmentCreate"]["success"]:
        print(f"✓ Linked {url} to {issue_id}")
    else:
        print("Error: Failed to link URL", file=sys.stderr)
        sys.exit(1)

def show_issue(issue_id: str) -> None:
    """Show detailed information about an issue."""
    query = """
    query Issue($id: String!) {
        issue(id: $id) {
            identifier
            title
            description
            state {
                name
            }
            assignee {
                name
                email
            }
            priority
            createdAt
            updatedAt
            url
            labels {
                nodes {
                    name
                }
            }
        }
    }
    """
    
    result = graphql_request(query, {"id": issue_id})
    issue = result["issue"]
    
    priority_map = {0: "None", 1: "🔴 Urgent", 2: "🟠 High", 3: "🟡 Medium", 4: "⚪ Low"}
    priority_str = priority_map.get(issue["priority"], "None")
    
    print(f"{issue['identifier']}: {issue['title']}")
    print(f"Status: {issue['state']['name']}")
    print(f"Priority: {priority_str}")
    
    if issue["assignee"]:
        print(f"Assignee: {issue['assignee']['name']} ({issue['assignee']['email']})")
    else:
        print("Assignee: Unassigned")
    
    if issue["labels"]["nodes"]:
        labels = ", ".join(label["name"] for label in issue["labels"]["nodes"])
        print(f"Labels: {labels}")
    
    print(f"\nDescription:")
    print(issue["description"] or "(no description)")
    
    print(f"\nURL: {issue['url']}")
    print(f"Created: {issue['createdAt']}")
    print(f"Updated: {issue['updatedAt']}")

def main():
    parser = argparse.ArgumentParser(description="Linear CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # Create command
    create_parser = subparsers.add_parser("create", help="Create a new issue")
    create_parser.add_argument("--title", required=True, help="Issue title")
    create_parser.add_argument("--description", required=True, help="Issue description")
    create_parser.add_argument("--project", help="Project key (e.g., STX)")
    create_parser.add_argument("--priority", type=int, choices=[1, 2, 3, 4], 
                               help="Priority: 1=Urgent, 2=High, 3=Medium, 4=Low")
    
    # Update command
    update_parser = subparsers.add_parser("update", help="Update an issue")
    update_parser.add_argument("issue_id", help="Issue identifier (e.g., STX-41)")
    update_parser.add_argument("--status", help="New status")
    update_parser.add_argument("--assignee", help="Assignee email or @me")
    update_parser.add_argument("--title", help="New title")
    update_parser.add_argument("--priority", type=int, choices=[1, 2, 3, 4],
                               help="Priority: 1=Urgent, 2=High, 3=Medium, 4=Low")
    
    # Query command
    query_parser = subparsers.add_parser("query", help="Query issues")
    query_parser.add_argument("--project", help="Filter by project key")
    query_parser.add_argument("--status", help="Filter by status")
    query_parser.add_argument("--assignee", help="Filter by assignee (@me or email)")
    query_parser.add_argument("--limit", type=int, default=10, help="Max results")
    
    # Comment command
    comment_parser = subparsers.add_parser("comment", help="Add a comment")
    comment_parser.add_argument("issue_id", help="Issue identifier")
    comment_parser.add_argument("body", help="Comment text")
    
    # Link command
    link_parser = subparsers.add_parser("link", help="Link a URL to an issue")
    link_parser.add_argument("issue_id", help="Issue identifier")
    link_parser.add_argument("--url", required=True, help="URL to attach")
    link_parser.add_argument("--title", help="Link title (optional)")
    
    # Show command
    show_parser = subparsers.add_parser("show", help="Show issue details")
    show_parser.add_argument("issue_id", help="Issue identifier")
    
    args = parser.parse_args()
    
    if args.command == "create":
        create_issue(args.title, args.description, args.project, args.priority)
    elif args.command == "update":
        update_issue(args.issue_id, args.status, args.assignee, args.title, args.priority)
    elif args.command == "query":
        query_issues(args.project, args.status, args.assignee, args.limit)
    elif args.command == "comment":
        add_comment(args.issue_id, args.body)
    elif args.command == "link":
        link_url(args.issue_id, args.url, args.title)
    elif args.command == "show":
        show_issue(args.issue_id)

if __name__ == "__main__":
    main()
