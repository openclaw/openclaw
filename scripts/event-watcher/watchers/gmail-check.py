#!/usr/bin/env python3
"""
Gmail unread checker for Event Watcher
Returns JSON with unread count and latest message info
"""

import sys
import json
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: gmail-check.py <credentials_file>"}))
        sys.exit(1)
    
    creds_file = Path(sys.argv[1]).expanduser()
    
    if not creds_file.exists():
        print(json.dumps({"error": f"Credentials file not found: {creds_file}"}))
        sys.exit(1)
    
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        print(json.dumps({"error": "google-auth libraries not installed"}))
        sys.exit(1)
    
    try:
        with open(creds_file) as f:
            token_data = json.load(f)
        
        creds = Credentials(
            token=token_data.get('token'),
            refresh_token=token_data.get('refresh_token'),
            token_uri=token_data.get('token_uri'),
            client_id=token_data.get('client_id'),
            client_secret=token_data.get('client_secret'),
        )
        
        gmail = build('gmail', 'v1', credentials=creds)
        results = gmail.users().messages().list(
            userId='me', 
            q='is:unread',
            maxResults=5
        ).execute()
        
        messages = results.get('messages', [])
        
        if messages:
            # Get details of first unread message
            msg = gmail.users().messages().get(
                userId='me', 
                id=messages[0]['id'],
                format='metadata',
                metadataHeaders=['From', 'Subject']
            ).execute()
            
            headers = {h['name']: h['value'] for h in msg['payload']['headers']}
            
            print(json.dumps({
                "count": len(messages),
                "latest_id": messages[0]['id'],
                "from": headers.get('From', 'Unknown'),
                "subject": headers.get('Subject', '(no subject)')
            }))
        else:
            print(json.dumps({"count": 0}))
            
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
