#!/usr/bin/env python3
"""
LLM Router - Unified Model Gateway Client
Route requests to 70+ LLMs (GPT, Claude, Gemini, Grok) via AIsa API.

Usage:
    python llm_router_client.py chat --model <model> --message <message> [--stream]
    python llm_router_client.py chat --model <model> --messages <json_array>
    python llm_router_client.py vision --model <model> --image <url> --prompt <text>
    python llm_router_client.py compare --models <model1,model2,...> --message <message>
    python llm_router_client.py models
"""

import argparse
import io
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Any, Dict, Generator, List, Optional

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


class LLMRouterClient:
    """Unified LLM Gateway Client for AIsa API."""
    
    BASE_URL = "https://api.aisa.one/v1"
    
    # Popular models for reference (check marketplace.aisa.one/pricing for full list)
    SUPPORTED_MODELS = {
        "openai": ["gpt-5.2", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-oss-120b"],
        "anthropic": ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-3-7-sonnet-20250219"],
        "google": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro-preview"],
        "xai": ["grok-4", "grok-3"],
        "meta": ["llama-3.1-405b", "llama-3.1-70b", "llama-3.1-8b"],
        "mistral": ["mistral-large", "mistral-medium", "mixtral-8x7b"],
    }
    
    def __init__(self, api_key: Optional[str] = None):
        """Initialize the client with an API key."""
        self.api_key = api_key or os.environ.get("AISA_API_KEY")
        if not self.api_key:
            raise ValueError(
                "AISA_API_KEY is required. Set it via environment variable or pass to constructor."
            )
    
    def _request(
        self, 
        method: str, 
        endpoint: str, 
        data: Optional[Dict[str, Any]] = None,
        stream: bool = False
    ) -> Any:
        """Make an HTTP request to the AIsa API."""
        url = f"{self.BASE_URL}{endpoint}"
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "OpenClaw-LLMRouter/1.0",
            "Accept": "application/json"
        }
        
        request_data = None
        if data:
            request_data = json.dumps(data).encode("utf-8")
        
        req = urllib.request.Request(url, data=request_data, headers=headers, method=method)
        
        try:
            response = urllib.request.urlopen(req, timeout=120)
            
            if stream:
                return self._handle_stream(response)
            else:
                return json.loads(response.read().decode("utf-8"))
                
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            try:
                return json.loads(error_body)
            except json.JSONDecodeError:
                return {"error": {"code": str(e.code), "message": error_body}}
        except urllib.error.URLError as e:
            return {"error": {"code": "NETWORK_ERROR", "message": str(e.reason)}}
    
    def _handle_stream(self, response) -> Generator[str, None, None]:
        """Handle streaming response (SSE)."""
        for line in response:
            line = line.decode("utf-8").strip()
            if line.startswith("data: "):
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    if "choices" in chunk and chunk["choices"]:
                        delta = chunk["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                except json.JSONDecodeError:
                    continue
    
    def chat(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        top_p: Optional[float] = None,
        stream: bool = False,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Create a chat completion.
        
        Args:
            model: Model identifier (e.g., gpt-4.1, claude-sonnet-4-5)
            messages: List of message dicts with 'role' and 'content'
            temperature: Sampling temperature (0-2)
            max_tokens: Maximum tokens to generate
            top_p: Nucleus sampling parameter
            stream: Whether to stream the response
            **kwargs: Additional parameters (functions, function_call, etc.)
        
        Returns:
            Chat completion response
        """
        payload = {
            "model": model,
            "messages": messages,
            "stream": stream
        }
        
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if top_p is not None:
            payload["top_p"] = top_p
        
        # Add any additional kwargs
        payload.update(kwargs)
        
        return self._request("POST", "/chat/completions", data=payload, stream=stream)
    
    def chat_stream(
        self,
        model: str,
        messages: List[Dict[str, str]],
        **kwargs
    ) -> Generator[str, None, None]:
        """
        Create a streaming chat completion.
        
        Yields content chunks as they arrive.
        """
        return self.chat(model=model, messages=messages, stream=True, **kwargs)
    
    def vision(
        self,
        model: str,
        image_url: str,
        prompt: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Analyze an image with a vision-capable model.
        
        Args:
            model: Vision-capable model (e.g., gpt-4o, gemini-1.5-pro)
            image_url: URL of the image to analyze
            prompt: Question or instruction about the image
        
        Returns:
            Chat completion response
        """
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            }
        ]
        return self.chat(model=model, messages=messages, **kwargs)
    
    def compare_models(
        self,
        models: List[str],
        message: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Compare responses from multiple models.
        
        Args:
            models: List of model identifiers
            message: The message to send to each model
        
        Returns:
            Dict with model names as keys and results as values
        """
        import time
        
        results = {}
        for model in models:
            start = time.time()
            try:
                response = self.chat(
                    model=model,
                    messages=[{"role": "user", "content": message}],
                    **kwargs
                )
                elapsed = time.time() - start
                
                if "error" in response:
                    results[model] = {
                        "success": False,
                        "error": response["error"],
                        "latency": elapsed
                    }
                else:
                    content = response.get("choices", [{}])[0].get("message", {}).get("content", "")
                    usage = response.get("usage", {})
                    results[model] = {
                        "success": True,
                        "response": content,
                        "latency": elapsed,
                        "tokens": usage.get("total_tokens", 0),
                        "cost": usage.get("cost", 0)
                    }
            except Exception as e:
                results[model] = {
                    "success": False,
                    "error": str(e),
                    "latency": time.time() - start
                }
        
        return results
    
    def list_models(self) -> Dict[str, List[str]]:
        """List supported model families and models."""
        return self.SUPPORTED_MODELS


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="LLM Router - Unified Model Gateway (70+ models)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s chat --model gpt-4.1 --message "Hello!"
    %(prog)s chat --model claude-sonnet-4-5 --message "Write a poem" --stream
    %(prog)s chat --model gpt-4 --system "You are a pirate" --message "Greet me"
    %(prog)s vision --model gpt-4o --image "https://example.com/img.jpg" --prompt "Describe this"
    %(prog)s compare --models "gpt-4.1,claude-sonnet-4-5" --message "Explain AI"
    %(prog)s models
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command")
    
    # Chat command
    chat_parser = subparsers.add_parser("chat", help="Send a chat completion request")
    chat_parser.add_argument("--model", "-m", required=True, help="Model identifier")
    chat_parser.add_argument("--message", help="User message")
    chat_parser.add_argument("--messages", help="Full messages array as JSON")
    chat_parser.add_argument("--system", "-s", help="System prompt")
    chat_parser.add_argument("--temperature", "-t", type=float, help="Temperature (0-2)")
    chat_parser.add_argument("--max-tokens", type=int, help="Max tokens to generate")
    chat_parser.add_argument("--stream", action="store_true", help="Stream the response")
    
    # Vision command
    vision_parser = subparsers.add_parser("vision", help="Analyze an image")
    vision_parser.add_argument("--model", "-m", required=True, help="Vision-capable model")
    vision_parser.add_argument("--image", "-i", required=True, help="Image URL")
    vision_parser.add_argument("--prompt", "-p", required=True, help="Question about the image")
    vision_parser.add_argument("--max-tokens", type=int, help="Max tokens to generate")
    
    # Compare command
    compare_parser = subparsers.add_parser("compare", help="Compare multiple models")
    compare_parser.add_argument("--models", required=True, help="Comma-separated model list")
    compare_parser.add_argument("--message", "-m", required=True, help="Message to send")
    compare_parser.add_argument("--temperature", "-t", type=float, help="Temperature")
    compare_parser.add_argument("--max-tokens", type=int, help="Max tokens")
    
    # Models command
    subparsers.add_parser("models", help="List supported models")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    # Models command doesn't need API key
    if args.command == "models":
        print(json.dumps(LLMRouterClient.SUPPORTED_MODELS, indent=2))
        sys.exit(0)
    
    try:
        client = LLMRouterClient()
    except ValueError as e:
        print(json.dumps({"error": {"code": "AUTH_ERROR", "message": str(e)}}))
        sys.exit(1)
    
    result = None
    
    if args.command == "chat":
        # Build messages
        if args.messages:
            messages = json.loads(args.messages)
        elif args.message:
            messages = []
            if args.system:
                messages.append({"role": "system", "content": args.system})
            messages.append({"role": "user", "content": args.message})
        else:
            print(json.dumps({"error": {"code": "INVALID_INPUT", "message": "Either --message or --messages is required"}}))
            sys.exit(1)
        
        kwargs = {}
        if args.temperature is not None:
            kwargs["temperature"] = args.temperature
        if args.max_tokens is not None:
            kwargs["max_tokens"] = args.max_tokens
        
        if args.stream:
            # Streaming mode
            try:
                for chunk in client.chat_stream(model=args.model, messages=messages, **kwargs):
                    print(chunk, end="", flush=True)
                print()  # Final newline
                sys.exit(0)
            except Exception as e:
                print(json.dumps({"error": {"code": "STREAM_ERROR", "message": str(e)}}))
                sys.exit(1)
        else:
            result = client.chat(model=args.model, messages=messages, **kwargs)
    
    elif args.command == "vision":
        kwargs = {}
        if args.max_tokens is not None:
            kwargs["max_tokens"] = args.max_tokens
        result = client.vision(
            model=args.model,
            image_url=args.image,
            prompt=args.prompt,
            **kwargs
        )
    
    elif args.command == "compare":
        models = [m.strip() for m in args.models.split(",")]
        kwargs = {}
        if args.temperature is not None:
            kwargs["temperature"] = args.temperature
        if args.max_tokens is not None:
            kwargs["max_tokens"] = args.max_tokens
        result = client.compare_models(models=models, message=args.message, **kwargs)
    
    if result:
        output = json.dumps(result, indent=2, ensure_ascii=False)
        try:
            print(output)
        except UnicodeEncodeError:
            print(json.dumps(result, indent=2, ensure_ascii=True))
        
        # Exit with error code if result contains error
        if isinstance(result, dict) and "error" in result:
            sys.exit(1)
        sys.exit(0)


if __name__ == "__main__":
    main()
