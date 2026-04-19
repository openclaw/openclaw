#!/usr/bin/env python3
"""
Simple Media Server for WebChat
Serves images, audio, and video files from the current directory with proper CORS headers
Supports range requests for seeking in audio/video
"""

import os
import sys
import json
import mimetypes
import argparse
import math
import re
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs
import base64
from pathlib import Path
import html

class MediaServerHandler(SimpleHTTPRequestHandler):
    """Custom handler that serves media files with proper headers"""
    
    def __init__(self, *args, **kwargs):
        self.directory = os.getcwd()
        super().__init__(*args, **kwargs)
    
    def get_full_file_path(self, requested_path):
        """Convert requested path to absolute file path, with security restrictions"""
        # Normalize the requested path to prevent directory traversal
        normalized_path = os.path.normpath(requested_path)
        
        # If the path is absolute or contains directory traversal
        if normalized_path.startswith('/') or '..' in normalized_path.split(os.sep):
            # Resolve against the configured root directory
            # Remove leading slash and join with root directory
            relative_part = requested_path.lstrip('/')
            potential_path = os.path.join(self.directory, relative_part)
            # Normalize to resolve any .. components
            potential_path = os.path.normpath(potential_path)
            
            # Verify the resolved path is within the configured directory
            if not potential_path.startswith(os.path.normpath(self.directory) + os.sep) and potential_path != os.path.normpath(self.directory):
                # Attempt to access outside the configured root - deny access
                return None
            
            if os.path.exists(potential_path):
                return potential_path
            return None
        else:
            # Relative path - resolve based on root folder (current working directory)
            potential_path = os.path.join(self.directory, requested_path)
            potential_path = os.path.normpath(potential_path)
            
            # Verify the resolved path is within the configured directory
            if not potential_path.startswith(os.path.normpath(self.directory) + os.sep) and potential_path != os.path.normpath(self.directory):
                return None
            
            return potential_path if os.path.exists(potential_path) else None
    
    def do_GET(self):
        """Handle GET requests"""
        parsed_path = urlparse(self.path)
        path = unquote(parsed_path.path)
        query_params = parse_qs(parsed_path.query)
        
        # Handle API endpoints
        if path == '/api/list':
            page = int(query_params.get('page', [1])[0])
            per_page = int(query_params.get('per_page', [34])[0])
            self.handle_list_media(page, per_page)
        elif path == '/api/media-info':
            self.handle_media_info(parsed_path.query)
        elif path == '/' or path == '':
            # Serve status page with file listing
            self.serve_status_page()
        else:
            # Serve files normally with range support
            self.serve_file_with_range(path)
    
    def get_media_file_list(self, max_depth=2):
        """Return list of media files in the directory (limited to max_depth subdirectories)"""
        media_files = []
        media_extensions = {
            'image': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'],
            'audio': ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'],
            'video': ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.m4v', '.mpg', '.mpeg']
        }
        
        # Walk directories with depth limit
        for root, dirs, files in os.walk('.'):
            # Calculate current depth
            rel_path = os.path.relpath(root, '.')
            if rel_path == '.':
                depth = 0
            else:
                depth = len(rel_path.split(os.sep))
            
            # Skip if depth exceeds max_depth
            if depth > max_depth:
                # Remove subdirectories to prevent further walking
                dirs.clear()
                continue
            
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                media_type = None
                for mtype, exts in media_extensions.items():
                    if ext in exts:
                        media_type = mtype
                        break
                
                if media_type:
                    full_path = os.path.join(root, file)
                    rel_path_file = os.path.relpath(full_path, '.')
                    # Get the full absolute path
                    abs_path = os.path.abspath(full_path)
                    mime_type, _ = mimetypes.guess_type(file)
                    if not mime_type:
                        mime_map = {
                            '.ogg': 'audio/ogg',
                            '.mp3': 'audio/mpeg',
                            '.wav': 'audio/wav',
                            '.flac': 'audio/flac',
                            '.m4a': 'audio/mp4',
                            '.aac': 'audio/aac',
                            '.opus': 'audio/opus',
                            '.mp4': 'video/mp4',
                            '.webm': 'video/webm',
                            '.avi': 'video/x-msvideo',
                            '.mov': 'video/quicktime',
                            '.mkv': 'video/x-matroska',
                            '.wma': 'audio/x-ms-wma'
                        }
                        mime_type = mime_map.get(ext, f'{media_type}/x-unknown')
                    
                    media_files.append({
                        'path': rel_path_file,
                        'full_path': abs_path,
                        'filename': file,
                        'mimeType': mime_type,
                        'type': media_type,
                        'size': os.path.getsize(full_path),
                        'depth': depth
                    })
        
        # Sort by filename
        media_files.sort(key=lambda x: x['filename'])
        return media_files
    
    def format_size(self, size):
        """Format file size in human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} TB"
    
    def serve_status_page(self):
        """Serve a status page with full file listing (no pagination)"""
        all_media = self.get_media_file_list(max_depth=getattr(global_args, 'max_depth', 2))
        total_files = len(all_media)
        
        # Generate file listing HTML with compact spacing
        file_list_html = ''
        for media in all_media:
            # Use RELATIVE path for display and actions
            rel_path = media['path']
            dir_path = os.path.dirname(rel_path)
            if not dir_path or dir_path == '.':
                dir_path = "."
            filename = media['filename']
            
            # Escape the path for safe embedding in JavaScript
            escaped_path = html.escape(rel_path)
            js_escaped_path = escaped_path.replace("'", "\\'").replace('"', '\\"')
            
            file_list_html += f'''
            <tr>
                <td>
                    <div class="file-info">
                        <strong class="filename">{html.escape(filename)}</strong>
                        <span class="filepath">{html.escape(dir_path)}</span>
                    </div>
                </td>
                <td>
                    <button class="action-btn" onclick="window.open('{js_escaped_path}', '_blank')">▶ Open</button>
                    <button class="action-btn" onclick="copyToClipboard('{js_escaped_path}')">📋 Copy Path</button>
                </td>
                <td><span class="badge badge-{media['type']}">{media['type']}</span></td>
                <td>{media['mimeType']}</td>
                <td>{self.format_size(media['size'])}</td>
            </tr>
'''
        
        if not file_list_html:
            file_list_html = '<tr><td colspan="5">No media files found in current directory (max depth: 2 folders)</td></tr>'
        
        html_content = f'''<!DOCTYPE html>
<html>
<head>
    <title>OpenClaw Media Server</title>
    <meta charset="utf-8">
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    max-width: 1400px;
    margin: 0 auto;
    padding: 0px 0px 0px 0px;
    background: #121212;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}}
        .header {{
            position: sticky;
            top: 0;
            background: #121212;
            z-index: 10;
            padding: 10px 20px 0 20px;
        }}
.content {{
    flex: 1;
    overflow-y: auto;
    padding: 0 20px;
    scrollbar-width: none;
    -ms-overflow-style: none;
}}
.content::-webkit-scrollbar {{
    display: none;
}}        h1 {{
            color: #4CAF50;
            border-bottom: 2px solid #4CAF50;
            padding-bottom: 5px;
            margin: 0 0 10px 0;
            font-size: 1.8em;
        }}
        .status {{
            background: #4CAF50;
            color: white;
            padding: 6px;
            border-radius: 5px;
            margin: 0 0 6px 0;
            font-size: 14px;
        }}
        .stats {{
            background: #2196F3;
            color: white;
            padding: 6px;
            border-radius: 5px;
            margin: 0 0 6px 0;
            font-size: 14px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: #1e1e1e;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            margin: 0 0 8px 0;
        }}
        th, td {{
            padding: 3px 6px;
            text-align: left;
            border-bottom: 1px solid #4a4a4a;
            vertical-align: middle;
        }}
        th {{
            background: #1e3a2f;
            color: #4CAF50;
            padding: 5px 6px;
            font-size: 13px;
            font-weight: bold;
            position: sticky;
            top: 0;
        }}
        tr:hover {{
            background: #2a2a2a;
        }}
        .file-info {{
            display: flex;
            align-items: baseline;
            flex-wrap: wrap;
            gap: 8px;
        }}
        .filename {{
            font-size: 14px;
            font-weight: bold;
            color: #ffffff;
        }}
        .filepath {{
            font-size: 12px;
            color: #b0b0b0;
            font-family: monospace;
        }}
        .action-btn {{
            background: #2196F3;
            color: white;
            border: none;
            padding: 4px 10px;
            margin: 0 4px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            transition: background 0.2s;
        }}
        .action-btn:hover {{
            background: #45a049;
            transform: translateY(-1px);
        }}
        .action-btn:active {{
            transform: translateY(1px);
        }}
        .footer {{
            margin-top: 12px;
            text-align: center;
            color: #999;
            font-size: 12px;
            margin-bottom: 10px;
        }}
        .badge {{
            display: inline-block;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
        }}
        .badge-audio {{ background: #3498db; color: white; }}
        .badge-video {{ background: #9b59b6; color: white; }}
        .badge-image {{ background: #e67e22; color: white; }}
        .depth-info {{
            background: #9b59b6;
            color: white;
            padding: 6px;
            border-radius: 5px;
            margin: 6px 0 6px 0;
            font-size: 14px;
            text-align: center;
        }}
        .depth-info code {{
            background: rgba(0,0,0,0.2);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            color: white;
            font-weight: bold;
            position: relative;
            top: -1px;
        }}
        .depth-info code:hover {{
            background: rgba(0,0,0,0.3);
        }}
        .toast {{
            visibility: hidden;
            min-width: 250px;
            background-color: #1a1a1a;
            color: #4CAF50;
            text-align: center;
            border-radius: 2px;
            padding: 12px;
            position: fixed;
            z-index: 1000;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 13px;
            border: 1px solid #4CAF50;
        }}
        .toast.show {{
            visibility: visible;
            animation: fadein 0.5s, fadeout 0.5s 2.5s;
        }}
        @keyframes fadein {{
            from {{bottom: 0; opacity: 0;}}
            to {{bottom: 30px; opacity: 1;}}
        }}
        @keyframes fadeout {{
            from {{bottom: 30px; opacity: 1;}}
            to {{bottom: 0; opacity: 0;}}
        }}
    </style>
</head>
<body>
    <div id="toast" class="toast"></div>
    
    <div class="header">
        <h1>🎵 OpenClaw Media Server</h1>
        <div class="status">
            ✅ Media server is running | Port: {getattr(global_args, 'port', 18791)} | Directory: {os.getcwd()}
        </div>
        <div class="stats">
            📊 Total media files: {total_files}
        </div>
        <div class="depth-info">
            Depth: {getattr(global_args, 'max_depth', 2)}&nbsp;&nbsp; Change Depth: <code>python3 media_server.py --max-depth 5</code> &nbsp;&nbsp; Change Port: <code>python3 media_server.py --port 8080</code> &nbsp;&nbsp; Change Dir: <code>python3 media_server.py --directory /path/to/media</code>
        </div>
    </div>
    
    <div class="content">
        <table>
            <thead>
                <tr>
                    <th>Filename & Path</th>
                    <th>Actions</th>
                    <th>Type</th>
                    <th>MIME Type</th>
                    <th>Size</th>
                </tr>
            </thead>
            <tbody>
                {file_list_html}
            </tbody>
        </table>
    </div>
    
    <div class="footer">
        <p>OpenClaw Media Server - Supports seeking, streaming, and CORS &nbsp;|&nbsp; 📷 Images (jpg, jpeg, png, gif, webp, svg, bmp) &nbsp;&nbsp;|&nbsp; 🎵 Audio (mp3, wav, ogg, flac, m4a, aac, opus, wma) &nbsp;&nbsp;|&nbsp; 🎬 Video (mp4, webm, avi, mov, mkv, m4v, mpg, mpeg)</p>
    </div>
    
    <script>
        function copyToClipboard(text) {{
            navigator.clipboard.writeText(text).then(function() {{
                var toast = document.getElementById("toast");
                toast.textContent = "✓ Copied: " + text;
                toast.className = "toast show";
                setTimeout(function(){{ toast.className = toast.className.replace("show", ""); }}, 3000);
            }}, function(err) {{
                console.error('Could not copy text: ', err);
                var toast = document.getElementById("toast");
                toast.textContent = "❌ Failed to copy";
                toast.className = "toast show";
                setTimeout(function(){{ toast.className = toast.className.replace("show", ""); }}, 3000);
            }});
        }}
    </script>
</body>
</html>'''
        
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Access-Control-Allow-Origin', 'http://localhost:18791')
        self.end_headers()
        self.wfile.write(html_content.encode())
    
    def handle_list_media(self, page=1, per_page=34):
        """Return JSON list of media files with pagination"""
        all_media = self.get_media_file_list(max_depth=getattr(global_args, 'max_depth', 2))
        total_files = len(all_media)
        total_pages = math.ceil(total_files / per_page) if total_files > 0 else 1
        
        # Ensure page is within bounds
        page = max(1, min(page, total_pages))
        
        # Get paginated files
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        media_files = all_media[start_idx:end_idx]
        
        response = {
            'page': page,
            'per_page': per_page,
            'total': total_files,
            'total_pages': total_pages,
            'files': media_files
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', 'http://localhost:18791')
        self.end_headers()
        self.wfile.write(json.dumps(response, indent=2).encode())
    
    def handle_media_info(self, query):
        """Get info about a specific media file with size limit"""
        params = {}
        if query:
            for param in query.split('&'):
                if '=' in param:
                    key, value = param.split('=', 1)
                    params[key] = value
        
        media_path = params.get('path', '')
        if not media_path:
            self.send_error(400, 'Missing path parameter')
            return
        
        safe_path = self.get_full_file_path(media_path)
        if not safe_path:
            self.send_error(403, 'Access denied')
            return
        
        if os.path.isdir(safe_path):
            self.send_error(400, 'Path is a directory')
            return
        
        if not os.path.exists(safe_path):
            self.send_error(404, 'File not found')
            return
        
        # Add size limit check (10MB max for base64 encoding)
        MAX_MEDIA_SIZE = 10 * 1024 * 1024  # 10MB
        file_size = os.path.getsize(safe_path)
        if file_size > MAX_MEDIA_SIZE:
            self.send_error(413, f'File too large for media info endpoint (max {MAX_MEDIA_SIZE // (1024*1024)}MB)')
            return
        
        mime_type, _ = mimetypes.guess_type(safe_path)
        ext = os.path.splitext(safe_path)[1].lower()
        
        if not mime_type:
            mime_map = {
                '.ogg': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.m4a': 'audio/mp4',
                '.aac': 'audio/aac',
                '.opus': 'audio/opus',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.mkv': 'video/x-matroska'
            }
            mime_type = mime_map.get(ext, 'application/octet-stream')
        
        try:
            # Read file in chunks to avoid memory issues
            with open(safe_path, 'rb') as f:
                media_data = f.read()
            
            base64_data = base64.b64encode(media_data).decode('ascii')
            
            response = {
                'path': media_path,
                'full_path': os.path.abspath(safe_path),
                'mimeType': mime_type,
                'size': len(media_data),
                'base64': base64_data,
                'dataUrl': f'data:{mime_type};base64,{base64_data}'
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', 'http://localhost:18791')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_error(500, f'Error reading file: {str(e)}')
    
    def serve_file_with_range(self, path):
        """Serve file with support for range requests (for seeking in audio/video)"""
        safe_path = self.get_full_file_path(path)
        
        if not safe_path:
            self.send_error(403, 'Access denied')
            return
        
        if os.path.isdir(safe_path):
            self.send_error(404, 'Not found')
            return
        
        if not os.path.exists(safe_path):
            self.send_error(404, 'File not found')
            return
        
        file_size = os.path.getsize(safe_path)
        
        range_header = self.headers.get('Range')
        start = 0
        end = file_size - 1
        status_code = 200
        
        if range_header and range_header.startswith('bytes='):
            status_code = 206
            range_value = range_header[6:]
            if '-' in range_value:
                parts = range_value.split('-')
                if parts[0]:
                    start = int(parts[0])
                if parts[1]:
                    end = int(parts[1])
        
        if start >= file_size or end >= file_size or start > end:
            self.send_error(416, 'Requested range not satisfiable')
            return
        
        content_length = end - start + 1
        
        mime_type, _ = mimetypes.guess_type(safe_path)
        ext = os.path.splitext(safe_path)[1].lower()
        if not mime_type:
            mime_map = {
                '.ogg': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.m4a': 'audio/mp4',
                '.aac': 'audio/aac',
                '.opus': 'audio/opus',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.mkv': 'video/x-matroska',
                '.m4v': 'video/x-m4v',
                '.mpg': 'video/mpeg',
                '.mpeg': 'video/mpeg',
            }
            mime_type = mime_map.get(ext, 'application/octet-stream')
        
        self.send_response(status_code)
        self.send_header('Content-Type', mime_type)
        self.send_header('Content-Length', str(content_length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Access-Control-Allow-Origin', 'http://localhost:18791')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        
        with open(safe_path, 'rb') as f:
            f.seek(start)
            remaining = content_length
            chunk_size = 8192
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
    
    def end_headers(self):
        """Add CORS headers to all responses (restricted to localhost)"""
        self.send_header('Access-Control-Allow-Origin', 'http://localhost:18791')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle OPTIONS requests for CORS preflight"""
        self.send_response(200)
        self.end_headers()
    
    def log_message(self, format, *args):
        """Custom log format"""
        sys.stdout.write(f"[{self.log_date_time_string()}] {args[0]}\n")
        sys.stdout.flush()

def main():
    parser = argparse.ArgumentParser(description='Simple Media Server for WebChat')
    parser.add_argument('--port', type=int, default=18791, help='Port to run the server on')
    parser.add_argument('--directory', default='.', help='Directory to serve media from')
    parser.add_argument('--max-depth', type=int, default=2, help='Maximum directory depth to scan (default: 2)')
    parser.add_argument('--bind-all', action='store_true', help='Bind to all interfaces (0.0.0.0) instead of localhost only')
    args = parser.parse_args()
    
    # Change to the specified directory - this becomes the root for relative paths
    os.chdir(args.directory)
    
    # Store args for access in handler
    global global_args
    global_args = args
    
    # Bind to localhost by default for security, allow --bind-all for wider access
    bind_host = '0.0.0.0' if args.bind_all else '127.0.0.1'
    server = HTTPServer((bind_host, args.port), MediaServerHandler)
    
    print(f"\n🎵 Media Server Started")
    print(f"   Directory: {os.getcwd()}")
    print(f"   Port: {args.port}")
    print(f"   Bind address: {bind_host}")
    print(f"   Max Depth: {args.max_depth} directory levels")
    print(f"   URL: http://localhost:{args.port}")
    if args.bind_all:
        print(f"   Also available on network: http://<your-ip>:{args.port}")
    print(f"\n   Status page: http://localhost:{args.port}/")
    print(f"\n   Supported formats:")
    print(f"   📷 Images: jpg, png, gif, webp, svg, bmp")
    print(f"   🎵 Audio: mp3, wav, ogg, flac, m4a, aac, opus, wma")
    print(f"   🎬 Video: mp4, webm, avi, mov, mkv, m4v, mpg, mpeg")
    print(f"\n   Features:")
    print(f"   - Range requests for seeking in audio/video")
    print(f"   - CORS restricted to localhost (use --bind-all for network access)")
    print(f"   - File size limit: 10MB for API endpoints")
    print(f"   - Full file list (no pagination)")
    print(f"   - Limited to {args.max_depth} directory depth")
    print(f"   - Full file path displayed for each file")
    print(f"\n   Press Ctrl+C to stop\n")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")
        server.shutdown()

if __name__ == '__main__':
    main()