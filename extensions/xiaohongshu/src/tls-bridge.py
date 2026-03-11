#!/usr/bin/env python3
"""
Tiny JSON-lines bridge that uses curl_cffi to make HTTP requests
with Chrome TLS fingerprint impersonation.

Protocol (stdin → stdout, one JSON object per line):
  Request:  {"id":"…","method":"GET"|"POST","url":"…","headers":{…},"cookies":"…","body":"…"}
  Response: {"id":"…","status":200,"headers":{…},"body":"…"}
  Error:    {"id":"…","error":"…"}

Exit: send {"id":"_quit"} or close stdin.
"""

import json
import sys

try:
    from curl_cffi.requests import Session
except ImportError:
    print(json.dumps({"id": "_init", "error": "curl_cffi not installed. Run: pip3 install curl_cffi"}), flush=True)
    sys.exit(1)

print(json.dumps({"id": "_init", "ok": True}), flush=True)

session = Session(impersonate="chrome124")


def parse_cookie(cookie_str: str) -> dict:
    result = {}
    if not cookie_str:
        return result
    for pair in cookie_str.split(";"):
        pair = pair.strip()
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        result[k.strip()] = v.strip()
    return result


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        print(json.dumps({"id": "?", "error": f"Invalid JSON: {e}"}), flush=True)
        continue

    req_id = req.get("id", "?")
    if req_id == "_quit":
        break

    try:
        method = req.get("method", "GET").upper()
        url = req["url"]
        headers = req.get("headers", {})
        cookie_str = req.get("cookies", "")
        body = req.get("body")

        resp = session.request(
            method=method,
            url=url,
            headers=headers,
            cookies=parse_cookie(cookie_str),
            data=body.encode("utf-8") if body else None,
            allow_redirects=True,
        )

        resp_headers = dict(resp.headers)
        print(
            json.dumps(
                {
                    "id": req_id,
                    "status": resp.status_code,
                    "headers": resp_headers,
                    "body": resp.text,
                }
            ),
            flush=True,
        )
    except Exception as e:
        print(json.dumps({"id": req_id, "error": str(e)}), flush=True)

session.close()
