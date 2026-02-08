import argparse
import os
import sys
import json
import urllib.request
import urllib.error

def main():
    parser = argparse.ArgumentParser(description="Generic Remote Agent Client")
    parser.add_argument("--query", required=True, help="Input query/prompt for the remote agent")
    parser.add_argument("--agent", required=False, help="Agent ID or Name (optional)")
    parser.add_argument("--url", required=False, help="Override endpoint URL")
    parser.add_argument("--protocol", choices=["generic", "adk"], default="generic", help="Protocol format (generic or adk)")
    
    args = parser.parse_args()

    # Configuration via Environment Variables (Preferred for security)
    # Defaulting to a placeholder to prevent accidental calls to localhost in production
    endpoint = args.url or os.getenv("REMOTE_AGENT_URL")
    api_key = os.getenv("REMOTE_AGENT_KEY")

    if not endpoint:
        print(json.dumps({
            "error": "Configuration missing. Please set REMOTE_AGENT_URL env var or pass --url.",
            "status": "config_error"
        }))
        sys.exit(1)

    # Prepare headers
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw-Remote-Bridge/1.0"
    }
    
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # Prepare payload (Adapting to a common schema, e.g., OpenAI-like or generic)
    # You can customize this payload structure based on your target agent framework (VeADK, Google ADK)
    payload = {}
    
    if args.protocol == "adk":
        # Google Agent Development Kit (A2A) Protocol
        # See: https://google.github.io/adk-docs/
        payload = {
            "type": "req",
            "method": "agent.chat", # Standard method for chat interaction
            "params": {
                "messages": [{"role": "user", "content": args.query}]
            }
        }
        if args.agent:
            payload["agent"] = args.agent
    else:
        # Generic JSON Payload (Compatible with most webhooks/VeADK wrapper)
        payload = {
            "input": args.query,
            "query": args.query, # Redundant for compatibility
            "messages": [{"role": "user", "content": args.query}] # OpenAI compatibility
        }
        if args.agent:
            payload["agent_id"] = args.agent

    import ssl
    
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(endpoint, data=data, headers=headers, method="POST")
        
        # Create a context that ignores SSL verification errors (for dev/testing)
        # In production, you might want to remove this or configure proper CA bundles
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        with urllib.request.urlopen(req, context=ctx) as response:
            response_body = response.read().decode("utf-8")
            
            # Try to parse as JSON for pretty printing, otherwise return raw text
            try:
                result_json = json.loads(response_body)
                print(json.dumps(result_json, indent=2, ensure_ascii=False))
            except json.JSONDecodeError:
                print(response_body)

    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(json.dumps({
            "error": f"HTTP {e.code}: {e.reason}",
            "details": error_body
        }, indent=2))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "error": f"Connection failed: {str(e)}"
        }, indent=2))
        sys.exit(1)

if __name__ == "__main__":
    main()
