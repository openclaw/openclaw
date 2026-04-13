"""
Bluesky MCP Server - Allows AI agents (like OpenClaw, Claude, etc.) to interact with Bluesky
This server exposes Bluesky operations as MCP tools that AI agents can call.

Usage:
  python mcp_server.py

The server reads credentials from credentials.json in the same directory.
"""

import sys
import os
import json
import urllib.request
from atproto import Client
from atproto import models

# Path setup
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, "credentials.json")

# Import MCP framework
try:
    from mcp.server import Server
    from mcp.types import Tool, TextContent
    import mcp.server.stdio
except ImportError:
    print("ERROR: MCP package not installed. Install with: pip install mcp")
    sys.exit(1)


def load_credentials():
    """Load credentials from credentials.json file"""
    if not os.path.exists(CREDENTIALS_FILE):
        raise FileNotFoundError(f"Credentials file not found at: {CREDENTIALS_FILE}")
    
    with open(CREDENTIALS_FILE, 'r') as f:
        creds = json.load(f)
    
    return creds.get('username', ''), creds.get('password', '')


def get_client():
    """Initialize and return authenticated Bluesky client"""
    username, password = load_credentials()
    client = Client()
    client.login(username, password)
    return client


def upload_image(client, image_path):
    """Upload an image to Bluesky and return the blob reference"""
    with open(image_path, 'rb') as f:
        image_data = f.read()
    blob_ref = client.upload_blob(image_data)
    return blob_ref.blob


def download_image_from_url(image_url, output_dir="downloads"):
    """Download an image from a URL and save it locally"""
    os.makedirs(output_dir, exist_ok=True)
    filename = image_url.split('/')[-1]
    if not filename:
        filename = f"image_{len(os.listdir(output_dir))}.jpg"
    output_path = os.path.join(output_dir, filename)
    urllib.request.urlretrieve(image_url, output_path)
    return output_path


# Create the MCP server
server = Server("bluesky-bot")


@server.list_tools()
async def list_tools():
    """List all available Bluesky tools"""
    return [
        Tool(
            name="bluesky_post",
            description="Create a new post on Bluesky. Can optionally attach images.",
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The text content of the post"
                    },
                    "images": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of image file paths to attach"
                    }
                },
                "required": ["text"]
            }
        ),
        Tool(
            name="bluesky_timeline",
            description="Get the authenticated user's timeline feed",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Number of posts to fetch (default: 20)"
                    },
                    "include_images": {
                        "type": "boolean",
                        "description": "Include image URLs in response (default: false)"
                    }
                }
            }
        ),
        Tool(
            name="bluesky_notifications",
            description="Get recent notifications for the authenticated user",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Number of notifications to fetch (default: 20)"
                    }
                }
            }
        ),
        Tool(
            name="bluesky_like",
            description="Like a specific post by its URI",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of the post to like (e.g., at://did:plc:.../app.bsky.feed.post:...)"
                    }
                },
                "required": ["post_uri"]
            }
        ),
        Tool(
            name="bluesky_repost",
            description="Repost (quote repost without text) a specific post by its URI",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of the post to repost"
                    }
                },
                "required": ["post_uri"]
            }
        ),
        Tool(
            name="bluesky_reply",
            description="Reply to a specific post. Can optionally attach images.",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of the post to reply to"
                    },
                    "text": {
                        "type": "string",
                        "description": "The reply text"
                    },
                    "images": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of image file paths to attach"
                    }
                },
                "required": ["post_uri", "text"]
            }
        ),
        Tool(
            name="bluesky_thread",
            description="View a thread (conversation) by post URI",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of any post in the thread"
                    },
                    "depth": {
                        "type": "integer",
                        "description": "How deep to fetch nested replies (default: 5)"
                    },
                    "include_images": {
                        "type": "boolean",
                        "description": "Include image URLs in response (default: false)"
                    }
                },
                "required": ["post_uri"]
            }
        ),
        Tool(
            name="bluesky_search",
            description="Search for posts by keyword",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return (default: 20)"
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="bluesky_profile",
            description="Get a user's profile by handle",
            inputSchema={
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": "The Bluesky handle (e.g., user.bsky.social). Leave empty for your own profile."
                    }
                }
            }
        ),
        Tool(
            name="bluesky_user_posts",
            description="Get posts from a specific user",
            inputSchema={
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": "The Bluesky handle of the user"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of posts to fetch (default: 20)"
                    },
                    "include_images": {
                        "type": "boolean",
                        "description": "Include image URLs in response (default: false)"
                    }
                },
                "required": ["handle"]
            }
        ),
        Tool(
            name="bluesky_chats",
            description="List all chat conversations for the authenticated user",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="bluesky_chat_messages",
            description="Get messages from a specific chat conversation",
            inputSchema={
                "type": "object",
                "properties": {
                    "convo_id": {
                        "type": "string",
                        "description": "The conversation ID"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of messages to fetch (default: 20)"
                    }
                },
                "required": ["convo_id"]
            }
        ),
        Tool(
            name="bluesky_send_chat",
            description="Send a message in a chat conversation",
            inputSchema={
                "type": "object",
                "properties": {
                    "convo_id": {
                        "type": "string",
                        "description": "The conversation ID"
                    },
                    "text": {
                        "type": "string",
                        "description": "The message text"
                    }
                },
                "required": ["convo_id", "text"]
            }
        ),
        Tool(
            name="bluesky_follow",
            description="Follow a user by their handle",
            inputSchema={
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": "The Bluesky handle to follow"
                    }
                },
                "required": ["handle"]
            }
        ),
        Tool(
            name="bluesky_post_likes",
            description="Get the list of users who liked a specific post",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of the post"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of likes to fetch (default: 20)"
                    }
                },
                "required": ["post_uri"]
            }
        ),
        Tool(
            name="bluesky_download_images",
            description="Download all images from a specific post",
            inputSchema={
                "type": "object",
                "properties": {
                    "post_uri": {
                        "type": "string",
                        "description": "The AT URI of the post"
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "Directory to save images (default: downloads)"
                    }
                },
                "required": ["post_uri"]
            }
        ),
        Tool(
            name="bluesky_get_mentions",
            description="Get recent posts that mention the authenticated user",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Number of mentions to fetch (default: 20)"
                    }
                }
            }
        ),
    ]


def format_thread(item, indent=0):
    """Format a thread item for response"""
    prefix = "  " * indent
    post = item.post
    author = post.author
    
    result = {
        "handle": author.handle,
        "display_name": author.display_name,
        "text": post.record.text,
        "likes": post.like_count,
        "replies": post.reply_count,
        "created_at": post.record.created_at,
        "uri": post.uri
    }
    
    if hasattr(post.record, 'embed') and post.record.embed:
        if hasattr(post.record.embed, 'images') and post.record.embed.images:
            result["images"] = [img.fullsize for img in post.record.embed.images]
    
    result["replies"] = []
    if hasattr(item, 'replies') and item.replies:
        for reply in item.replies:
            result["replies"].append(format_thread(reply, indent + 1))
    
    return result


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    """Execute a Bluesky tool"""
    try:
        client = get_client()
        
        if name == "bluesky_post":
            text = arguments["text"]
            images = arguments.get("images", [])
            
            embed = None
            if images:
                image_list = []
                for image_path in images:
                    blob = upload_image(client, image_path)
                    image_list.append(
                        models.AppBskyEmbedImages.Image(
                            alt=os.path.basename(image_path),
                            image=blob
                        )
                    )
                embed = models.AppBskyEmbedImages.Main(images=image_list)
            
            if embed:
                post = client.send_post(text=text, embed=embed)
            else:
                post = client.send_post(text=text)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "post_uri": post.uri,
                "post_cid": post.cid
            }, indent=2))]
        
        elif name == "bluesky_timeline":
            limit = arguments.get("limit", 20)
            include_images = arguments.get("include_images", False)
            
            feed = client.get_timeline(limit=limit)
            posts = []
            for item in feed.feed:
                post = item.post
                author = post.author
                post_data = {
                    "handle": author.handle,
                    "display_name": author.display_name,
                    "text": post.record.text,
                    "likes": post.like_count,
                    "reposts": post.repost_count,
                    "replies": post.reply_count,
                    "created_at": post.record.created_at,
                    "uri": post.uri,
                    "cid": post.cid
                }
                if include_images and hasattr(post.record, 'embed') and post.record.embed:
                    if hasattr(post.record.embed, 'images') and post.record.embed.images:
                        post_data["images"] = [img.fullsize for img in post.record.embed.images]
                posts.append(post_data)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "posts": posts,
                "count": len(posts)
            }, indent=2))]
        
        elif name == "bluesky_notifications":
            limit = arguments.get("limit", 20)
            
            notifs = client.get_notifications(limit=limit)
            notifications = []
            for notif in notifs.notifications:
                author = notif.author
                notif_data = {
                    "type": notif.reason,
                    "from_handle": author.handle,
                    "from_display_name": author.display_name,
                    "indexed_at": notif.indexed_at
                }
                if notif.reason_subject:
                    notif_data["subject"] = notif.reason_subject
                notifications.append(notif_data)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "notifications": notifications,
                "count": len(notifications)
            }, indent=2))]
        
        elif name == "bluesky_like":
            post_uri = arguments["post_uri"]
            like = client.like(uri=post_uri)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "like_uri": like.uri
            }, indent=2))]
        
        elif name == "bluesky_repost":
            post_uri = arguments["post_uri"]
            repost = client.repost(uri=post_uri)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "repost_uri": repost.uri
            }, indent=2))]
        
        elif name == "bluesky_reply":
            post_uri = arguments["post_uri"]
            text = arguments["text"]
            images = arguments.get("images", [])
            
            original_post = client.get_post(uri=post_uri)
            
            embed = None
            if images:
                image_list = []
                for image_path in images:
                    blob = upload_image(client, image_path)
                    image_list.append(
                        models.AppBskyEmbedImages.Image(
                            alt=os.path.basename(image_path),
                            image=blob
                        )
                    )
                embed = models.AppBskyEmbedImages.Main(images=image_list)
            
            if embed:
                reply = client.send_post(text=text, reply_to=original_post, embed=embed)
            else:
                reply = client.send_post(text=text, reply_to=original_post)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "reply_uri": reply.uri
            }, indent=2))]
        
        elif name == "bluesky_thread":
            post_uri = arguments["post_uri"]
            depth = arguments.get("depth", 5)
            
            thread = client.get_post_thread(uri=post_uri, depth=depth)
            thread_data = format_thread(thread.thread)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "thread": thread_data
            }, indent=2))]
        
        elif name == "bluesky_search":
            query = arguments["query"]
            limit = arguments.get("limit", 20)
            
            results = client.app.bsky.feed.search_posts(params={'q': query, 'limit': limit})
            posts = []
            for post in results.posts:
                author = post.author
                posts.append({
                    "handle": author.handle,
                    "display_name": author.display_name,
                    "text": post.record.text,
                    "likes": post.like_count,
                    "reposts": post.repost_count,
                    "created_at": post.record.created_at,
                    "uri": post.uri
                })
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "posts": posts,
                "count": len(posts)
            }, indent=2))]
        
        elif name == "bluesky_profile":
            handle = arguments.get("handle", "")
            if not handle:
                handle, _ = load_credentials()
            
            profile = client.get_profile(actor=handle)
            profile_data = {
                "handle": profile.handle,
                "display_name": profile.display_name,
                "description": profile.description,
                "followers_count": profile.followers_count,
                "follows_count": profile.follows_count,
                "posts_count": profile.posts_count,
                "did": profile.did,
                "avatar": profile.avatar,
                "created_at": profile.created_at
            }
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "profile": profile_data
            }, indent=2))]
        
        elif name == "bluesky_user_posts":
            handle = arguments["handle"]
            limit = arguments.get("limit", 20)
            include_images = arguments.get("include_images", False)
            
            posts = client.get_author_feed(actor=handle, limit=limit)
            post_list = []
            for item in posts.feed:
                post = item.post
                post_data = {
                    "text": post.record.text,
                    "likes": post.like_count,
                    "reposts": post.repost_count,
                    "replies": post.reply_count,
                    "created_at": post.record.created_at,
                    "uri": post.uri
                }
                if include_images and hasattr(post.record, 'embed') and post.record.embed:
                    if hasattr(post.record.embed, 'images') and post.record.embed.images:
                        post_data["images"] = [img.fullsize for img in post.record.embed.images]
                post_list.append(post_data)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "posts": post_list,
                "count": len(post_list)
            }, indent=2))]
        
        elif name == "bluesky_chats":
            chat_list = client.chat.bsky.convo.list_convos()
            convos = []
            for convo in chat_list.convos:
                convo_data = {
                    "id": convo.id,
                    "members": [],
                    "updated_at": convo.updated_at
                }
                for member in convo.members:
                    convo_data["members"].append({
                        "handle": member.handle,
                        "display_name": member.display_name
                    })
                if hasattr(convo.last_message, 'text'):
                    convo_data["last_message"] = convo.last_message.text
                convos.append(convo_data)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "conversations": convos,
                "count": len(convos)
            }, indent=2))]
        
        elif name == "bluesky_chat_messages":
            convo_id = arguments["convo_id"]
            limit = arguments.get("limit", 20)
            
            messages = client.chat.bsky.convo.get_messages(convo_id=convo_id, limit=limit)
            msg_list = []
            for msg in messages.messages:
                msg_data = {
                    "sender_handle": msg.sender.handle,
                    "text": msg.text if hasattr(msg, 'text') else '[Media/Other]',
                    "sent_at": msg.sent_at
                }
                msg_list.append(msg_data)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "messages": msg_list,
                "count": len(msg_list)
            }, indent=2))]
        
        elif name == "bluesky_send_chat":
            convo_id = arguments["convo_id"]
            text = arguments["text"]
            
            msg = client.chat.bsky.convo.send_message(
                params={
                    'convo_id': convo_id,
                    'message': {'text': text}
                }
            )
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message_id": msg.id,
                "text": text
            }, indent=2))]
        
        elif name == "bluesky_follow":
            handle = arguments["handle"]
            follow = client.follow(handle)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "following": handle
            }, indent=2))]
        
        elif name == "bluesky_post_likes":
            post_uri = arguments["post_uri"]
            limit = arguments.get("limit", 20)
            
            likes = client.get_likes(uri=post_uri, limit=limit)
            like_list = []
            for like in likes.likes:
                like_list.append({
                    "handle": like.actor.handle,
                    "display_name": like.actor.display_name,
                    "created_at": like.created_at
                })
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "post_uri": likes.uri,
                "likes": like_list,
                "count": len(like_list)
            }, indent=2))]
        
        elif name == "bluesky_download_images":
            post_uri = arguments["post_uri"]
            output_dir = arguments.get("output_dir", "downloads")
            
            post = client.get_post(uri=post_uri)
            os.makedirs(output_dir, exist_ok=True)
            
            downloaded = []
            if hasattr(post.record, 'embed') and post.record.embed:
                if hasattr(post.record.embed, 'images') and post.record.embed.images:
                    for img in post.record.embed.images:
                        path = download_image_from_url(img.fullsize, output_dir)
                        downloaded.append(path)
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "downloaded": downloaded,
                "count": len(downloaded)
            }, indent=2))]
        
        elif name == "bluesky_get_mentions":
            limit = arguments.get("limit", 20)
            username, _ = load_credentials()
            
            notifs = client.get_notifications(limit=limit)
            mentions = []
            for notif in notifs.notifications:
                if notif.reason == "mention":
                    author = notif.author
                    mentions.append({
                        "from_handle": author.handle,
                        "from_display_name": author.display_name,
                        "text": notif.record.text if hasattr(notif, 'record') and notif.record else 'N/A',
                        "subject": notif.reason_subject,
                        "indexed_at": notif.indexed_at
                    })
            
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "mentions": mentions,
                "count": len(mentions)
            }, indent=2))]
        
        else:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": f"Unknown tool: {name}"
            }, indent=2))]
    
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2))]


def main():
    """Run the MCP server"""
    print("Starting Bluesky MCP Server...", file=sys.stderr)
    print(f"Looking for credentials at: {CREDENTIALS_FILE}", file=sys.stderr)
    
    # Verify credentials exist
    username, password = load_credentials()
    print(f"Loaded credentials for: {username}", file=sys.stderr)
    print("Server is ready. Connect your AI agent now.", file=sys.stderr)
    
    # Run the server using stdio transport
    from mcp.server.stdio import stdio_server
    
    async def run():
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options()
            )
    
    import asyncio
    asyncio.run(run())


if __name__ == "__main__":
    main()
