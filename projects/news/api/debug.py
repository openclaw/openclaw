"""
Debug endpoint to check environment variables
"""

from http.server import BaseHTTPRequestHandler
import json
import os

class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        """Debug endpoint"""

        # 檢查環境變數
        line_token = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '')
        line_secret = os.environ.get('LINE_CHANNEL_SECRET', '')

        debug_info = {
            'status': 'ok',
            'env_check': {
                'LINE_CHANNEL_ACCESS_TOKEN': {
                    'exists': bool(line_token),
                    'length': len(line_token) if line_token else 0,
                    'first_10_chars': line_token[:10] if line_token else 'N/A'
                },
                'LINE_CHANNEL_SECRET': {
                    'exists': bool(line_secret),
                    'length': len(line_secret) if line_secret else 0,
                    'first_10_chars': line_secret[:10] if line_secret else 'N/A'
                }
            }
        }

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(debug_info, indent=2).encode())
