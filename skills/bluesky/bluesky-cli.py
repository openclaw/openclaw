"""
Bluesky CLI Bot - A command-line tool for interacting with Bluesky
Features: Post, like, reply, navigate threads, chat, and more
"""

import argparse
import sys
import json
import os
import urllib.request
from datetime import datetime
from atproto import Client
from atproto import models
from atproto_client.models.app.bsky.embed.images import Image

# Path to this script's directory for credentials file
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, "credentials.json")


def load_credentials():
    """Load credentials from credentials.json file"""
    if not os.path.exists(CREDENTIALS_FILE):
        print(f"[ERROR] Credentials file not found at: {CREDENTIALS_FILE}")
        print("Please create a credentials.json file with your username and password.")
        print("Example:")
        print('{')
        print('  "username": "your-handle.bsky.social",')
        print('  "password": "your-app-password"')
        print('}')
        sys.exit(1)
    
    try:
        with open(CREDENTIALS_FILE, 'r') as f:
            creds = json.load(f)
        
        username = creds.get('username', '')
        password = creds.get('password', '')
        
        if not username or not password:
            print("[ERROR] Username and password must be provided in credentials.json")
            sys.exit(1)
        
        return username, password
    except json.JSONDecodeError as e:
        print(f"[ERROR] Invalid JSON in credentials file: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] Failed to load credentials: {e}")
        sys.exit(1)


def get_client():
    """Initialize and return authenticated Bluesky client"""
    username, password = load_credentials()
    client = Client()
    client.login(username, password)
    return client


def get_post_uri(client, post_id):
    """Get the AT URI for a post"""
    return f"at://{post_id}/app.bsky.feed.post/{post_id}"


def upload_image(client, image_path):
    """Upload an image to Bluesky and return the blob reference"""
    if not os.path.exists(image_path):
        print(f"[ERROR] Image file not found: {image_path}")
        return None
    
    try:
        # Read the image file
        with open(image_path, 'rb') as f:
            image_data = f.read()
        
        # Upload the blob
        blob_ref = client.upload_blob(image_data)
        print(f"[SUCCESS] Image uploaded: {image_path}")
        return blob_ref.blob
    except Exception as e:
        print(f"[ERROR] Failed to upload image: {e}")
        return None


def create_post(text, images=None):
    """Create a new post on Bluesky, optionally with images"""
    client = get_client()
    try:
        # Build embed if images are provided
        embed = None
        if images:
            image_list = []
            for image_path in images:
                blob = upload_image(client, image_path)
                if blob:
                    image_list.append(
                        models.AppBskyEmbedImages.Image(
                            alt=os.path.basename(image_path),  # Use filename as alt text
                            image=blob
                        )
                    )
            
            if image_list:
                embed = models.AppBskyEmbedImages.Main(images=image_list)
        
        # Create post with or without embed
        if embed:
            post = client.send_post(text=text, embed=embed)
        else:
            post = client.send_post(text=text)
        
        print(f"[SUCCESS] Post created!")
        print(f"  CID: {post.cid}")
        print(f"  URI: {post.uri}")
        return post
    except Exception as e:
        print(f"[ERROR] Failed to create post: {e}")
        sys.exit(1)


def download_image_from_url(image_url, output_dir="downloads"):
    """Download an image from a URL and save it locally"""
    try:
        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)
        
        # Generate filename from URL
        filename = image_url.split('/')[-1]
        if not filename:
            filename = f"image_{len(os.listdir(output_dir))}.jpg"
        
        output_path = os.path.join(output_dir, filename)
        
        # Download the image
        urllib.request.urlretrieve(image_url, output_path)
        print(f"[SUCCESS] Image downloaded: {output_path}")
        return output_path
    except Exception as e:
        print(f"[ERROR] Failed to download image: {e}")
        return None


def get_timeline(limit=20, download_images=False):
    """Get the user's timeline"""
    client = get_client()
    try:
        feed = client.get_timeline(limit=limit)
        print(f"\n{'='*60}")
        print(f"TIMELINE (Last {len(feed.feed)} posts)")
        print(f"{'='*60}\n")
        
        for i, item in enumerate(feed.feed, 1):
            post = item.post
            author = post.author
            print(f"[{i}] @{author.handle}")
            print(f"    Display Name: {author.display_name or 'N/A'}")
            print(f"    Text: {post.record.text[:150]}...")
            print(f"    Likes: {post.like_count} | Reposts: {post.repost_count} | Replies: {post.reply_count}")
            print(f"    Created: {post.record.created_at}")
            print(f"    Post URI: {post.uri}")
            print(f"    Post CID: {post.cid}")
            
            # Show images if present
            if hasattr(post.record, 'embed') and post.record.embed:
                embed = post.record.embed
                if hasattr(embed, 'images') and embed.images:
                    print(f"    Images: {len(embed.images)}")
                    for img in embed.images:
                        print(f"      - {img.fullsize}")
                        if download_images:
                            download_image_from_url(img.fullsize)
            
            print(f"{'-'*60}")
        
        return feed
    except Exception as e:
        print(f"[ERROR] Failed to get timeline: {e}")
        sys.exit(1)


def get_notifications(limit=20):
    """Get recent notifications"""
    client = get_client()
    try:
        notifs = client.get_notifications(limit=limit)
        print(f"\n{'='*60}")
        print(f"NOTIFICATIONS ({len(notifs.notifications)} total)")
        print(f"{'='*60}\n")
        
        for i, notif in enumerate(notifs.notifications, 1):
            author = notif.author
            print(f"[{i}] Type: {notif.reason}")
            print(f"    From: @{author.handle} ({author.display_name or 'N/A'})")
            if notif.reason_subject:
                print(f"    Subject: {notif.reason_subject}")
            print(f"    Message: {notif.record.text[:150] if hasattr(notif, 'record') and notif.record else 'N/A'}")
            print(f"    Date: {notif.indexed_at}")
            print(f"{'-'*60}")
        
        return notifs
    except Exception as e:
        print(f"[ERROR] Failed to get notifications: {e}")
        sys.exit(1)


def like_post(post_uri):
    """Like a specific post by URI"""
    client = get_client()
    try:
        like = client.like(uri=post_uri)
        print(f"[SUCCESS] Post liked!")
        print(f"  Like URI: {like.uri}")
        return like
    except Exception as e:
        print(f"[ERROR] Failed to like post: {e}")
        sys.exit(1)


def repost_post(post_uri):
    """Repost a specific post by URI"""
    client = get_client()
    try:
        repost = client.repost(uri=post_uri)
        print(f"[SUCCESS] Post reposted!")
        print(f"  Repost URI: {repost.uri}")
        return repost
    except Exception as e:
        print(f"[ERROR] Failed to repost: {e}")
        sys.exit(1)


def reply_to_post(post_uri, text, images=None):
    """Reply to a specific post"""
    client = get_client()
    try:
        # Get the original post to extract root/parent info
        original_post = client.get_post(uri=post_uri)
        
        # Build embed if images are provided
        embed = None
        if images:
            image_list = []
            for image_path in images:
                blob = upload_image(client, image_path)
                if blob:
                    image_list.append(
                        models.AppBskyEmbedImages.Image(
                            alt=os.path.basename(image_path),
                            image=blob
                        )
                    )
            
            if image_list:
                embed = models.AppBskyEmbedImages.Main(images=image_list)
        
        # Create reply with or without embed
        if embed:
            reply = client.send_post(
                text=text,
                reply_to=original_post,
                embed=embed
            )
        else:
            reply = client.send_post(
                text=text,
                reply_to=original_post,
            )
        
        print(f"[SUCCESS] Reply posted!")
        print(f"  Reply URI: {reply.uri}")
        return reply
    except Exception as e:
        print(f"[ERROR] Failed to reply: {e}")
        sys.exit(1)


def get_thread(post_uri, depth=5, download_images=False):
    """Get a thread by post URI"""
    client = get_client()
    try:
        thread = client.get_post_thread(uri=post_uri, depth=depth)
        print(f"\n{'='*60}")
        print(f"THREAD VIEW")
        print(f"{'='*60}\n")
        
        def print_thread_item(item, indent=0):
            prefix = "  " * indent
            post = item.post
            author = post.author
            
            print(f"{prefix}[@{author.handle}] {author.display_name or 'N/A'}")
            print(f"{prefix}  Text: {post.record.text}")
            print(f"{prefix}  Likes: {post.like_count} | Replies: {post.reply_count}")
            print(f"{prefix}  Created: {post.record.created_at}")
            print(f"{prefix}  URI: {post.uri}")
            
            # Show and optionally download images
            if hasattr(post.record, 'embed') and post.record.embed:
                embed = post.record.embed
                if hasattr(embed, 'images') and embed.images:
                    print(f"{prefix}  Images: {len(embed.images)}")
                    for img in embed.images:
                        print(f"{prefix}    - {img.fullsize}")
                        if download_images:
                            download_image_from_url(img.fullsize)
            
            print()
            
            if hasattr(item, 'replies') and item.replies:
                for reply in item.replies:
                    print_thread_item(reply, indent + 1)
        
        print_thread_item(thread.thread)
        return thread
    except Exception as e:
        print(f"[ERROR] Failed to get thread: {e}")
        sys.exit(1)


def search_posts(query, limit=20):
    """Search for posts"""
    client = get_client()
    try:
        results = client.app.bsky.feed.search_posts(
            params={
                'q': query,
                'limit': limit
            }
        )
        print(f"\n{'='*60}")
        print(f"SEARCH RESULTS for '{query}'")
        print(f"{'='*60}\n")
        
        for i, post in enumerate(results.posts, 1):
            author = post.author
            print(f"[{i}] @{author.handle}")
            print(f"    Name: {author.display_name or 'N/A'}")
            print(f"    Text: {post.record.text[:150]}...")
            print(f"    Likes: {post.like_count} | Reposts: {post.repost_count}")
            print(f"    Created: {post.record.created_at}")
            print(f"    URI: {post.uri}")
            print(f"{'-'*60}")
        
        return results
    except Exception as e:
        print(f"[ERROR] Failed to search posts: {e}")
        sys.exit(1)


def get_profile(handle):
    """Get a user's profile"""
    client = get_client()
    try:
        profile = client.get_profile(actor=handle)
        print(f"\n{'='*60}")
        print(f"PROFILE")
        print(f"{'='*60}\n")
        print(f"  Handle: @{profile.handle}")
        print(f"  Display Name: {profile.display_name or 'N/A'}")
        print(f"  Description: {profile.description or 'N/A'}")
        print(f"  Followers: {profile.followers_count}")
        print(f"  Following: {profile.follows_count}")
        print(f"  Posts: {profile.posts_count}")
        print(f"  DID: {profile.did}")
        print(f"  Avatar: {profile.avatar or 'N/A'}")
        print(f"  Created: {profile.created_at}")
        print()
        return profile
    except Exception as e:
        print(f"[ERROR] Failed to get profile: {e}")
        sys.exit(1)


def get_user_posts(handle, limit=20, download_images=False):
    """Get posts from a specific user"""
    client = get_client()
    try:
        posts = client.get_author_feed(actor=handle, limit=limit)
        print(f"\n{'='*60}")
        print(f"POSTS by @{handle}")
        print(f"{'='*60}\n")
        
        for i, feed_item in enumerate(posts.feed, 1):
            post = feed_item.post
            print(f"[{i}] Text: {post.record.text[:150]}...")
            print(f"    Likes: {post.like_count} | Reposts: {post.repost_count} | Replies: {post.reply_count}")
            print(f"    Created: {post.record.created_at}")
            print(f"    URI: {post.uri}")
            
            # Show and optionally download images
            if hasattr(post.record, 'embed') and post.record.embed:
                embed = post.record.embed
                if hasattr(embed, 'images') and embed.images:
                    print(f"    Images: {len(embed.images)}")
                    for img in embed.images:
                        print(f"      - {img.fullsize}")
                        if download_images:
                            download_image_from_url(img.fullsize)
            
            print(f"{'-'*60}")
        
        return posts
    except Exception as e:
        print(f"[ERROR] Failed to get user posts: {e}")
        sys.exit(1)


def list_chats():
    """List all chat conversations"""
    client = get_client()
    try:
        chat_list = client.chat.bsky.convo.list_convos()
        print(f"\n{'='*60}")
        print(f"CHAT CONVERSATIONS ({len(chat_list.convos)} total)")
        print(f"{'='*60}\n")
        
        for i, convo in enumerate(chat_list.convos, 1):
            print(f"[{i}] ID: {convo.id}")
            print(f"    Members: {len(convo.members)}")
            for member in convo.members:
                print(f"      - @{member.handle} ({member.display_name or 'N/A'})")
            print(f"    Last Message: {convo.last_message.text if hasattr(convo.last_message, 'text') else 'N/A'}")
            print(f"    Updated: {convo.updated_at}")
            print(f"{'-'*60}")
        
        return chat_list
    except Exception as e:
        print(f"[ERROR] Failed to list chats: {e}")
        sys.exit(1)


def get_chat_messages(convo_id, limit=20):
    """Get messages from a specific conversation"""
    client = get_client()
    try:
        messages = client.chat.bsky.convo.get_messages(convo_id=convo_id, limit=limit)
        print(f"\n{'='*60}")
        print(f"MESSAGES in conversation {convo_id}")
        print(f"{'='*60}\n")
        
        for i, msg in enumerate(reversed(messages.messages), 1):
            sender = msg.sender
            text = msg.text if hasattr(msg, 'text') else '[Media/Other]'
            print(f"[{i}] From: @{sender.handle}")
            print(f"    Text: {text}")
            print(f"    Sent: {msg.sent_at}")
            print(f"{'-'*60}")
        
        return messages
    except Exception as e:
        print(f"[ERROR] Failed to get chat messages: {e}")
        sys.exit(1)


def send_chat_message(convo_id, text):
    """Send a message in a chat conversation"""
    client = get_client()
    try:
        msg = client.chat.bsky.convo.send_message(
            params={
                'convo_id': convo_id,
                'message': {
                    'text': text
                }
            }
        )
        print(f"[SUCCESS] Message sent!")
        print(f"  Text: {text}")
        print(f"  Message ID: {msg.id}")
        return msg
    except Exception as e:
        print(f"[ERROR] Failed to send message: {e}")
        sys.exit(1)


def follow_user(handle):
    """Follow a user"""
    client = get_client()
    try:
        follow = client.follow(handle)
        print(f"[SUCCESS] Now following @{handle}!")
        return follow
    except Exception as e:
        print(f"[ERROR] Failed to follow user: {e}")
        sys.exit(1)


def get_likes_for_post(post_uri, limit=20):
    """Get users who liked a specific post"""
    client = get_client()
    try:
        likes = client.get_likes(uri=post_uri, limit=limit)
        print(f"\n{'='*60}")
        print(f"LIKES for post")
        print(f"{'='*60}\n")
        print(f"  Post URI: {likes.uri}")
        print(f"  Total Likes: {len(likes.likes)}")
        
        for i, like in enumerate(likes.likes, 1):
            actor = like.actor
            print(f"  [{i}] @{actor.handle} ({actor.display_name or 'N/A'})")
            print(f"      Created: {like.created_at}")
        
        return likes
    except Exception as e:
        print(f"[ERROR] Failed to get likes: {e}")
        sys.exit(1)


def download_post_images(post_uri, output_dir="downloads"):
    """Download all images from a specific post"""
    client = get_client()
    try:
        post = client.get_post(uri=post_uri)
        os.makedirs(output_dir, exist_ok=True)
        
        if hasattr(post.record, 'embed') and post.record.embed:
            embed = post.record.embed
            if hasattr(embed, 'images') and embed.images:
                print(f"\n{'='*60}")
                print(f"Downloading {len(embed.images)} images from post")
                print(f"{'='*60}\n")
                
                downloaded = []
                for i, img in enumerate(embed.images, 1):
                    print(f"[{i}/{len(embed.images)}] Downloading image...")
                    path = download_image_from_url(img.fullsize, output_dir)
                    if path:
                        downloaded.append(path)
                
                print(f"\n[SUCCESS] Downloaded {len(downloaded)} images to {output_dir}/")
                return downloaded
            else:
                print("[INFO] No images found in this post")
                return []
        else:
            print("[INFO] No embed/images found in this post")
            return []
    except Exception as e:
        print(f"[ERROR] Failed to download images: {e}")
        sys.exit(1)


def interactive_mode():
    """Interactive CLI mode for Bluesky Bot"""
    client = get_client()
    username, _ = load_credentials()
    profile = client.get_profile(actor=username)
    
    print(f"\n{'='*60}")
    print(f"BLUESKY CLI BOT - Interactive Mode")
    print(f"Logged in as: @{profile.handle}")
    print(f"Display Name: {profile.display_name or 'N/A'}")
    print(f"{'='*60}\n")
    print("Commands:")
    print("  1.  Create Post (text only)")
    print("  2.  Create Post with Images")
    print("  3.  View Timeline")
    print("  4.  View Timeline (with image download)")
    print("  5.  View Notifications")
    print("  6.  Like a Post (by URI)")
    print("  7.  Repost a Post (by URI)")
    print("  8.  Reply to a Post (text only)")
    print("  9.  Reply to a Post with Images")
    print("  10. View Thread (by URI)")
    print("  11. View Thread (with image download)")
    print("  12. Search Posts")
    print("  13. View Profile")
    print("  14. View User Posts")
    print("  15. List Chats")
    print("  16. View Chat Messages")
    print("  17. Send Chat Message")
    print("  18. Follow User")
    print("  19. Get Post Likes")
    print("  20. Download Images from Post")
    print("  q.  Quit")
    print(f"{'='*60}\n")
    
    while True:
        choice = input("Enter command number: ").strip()
        
        if choice == 'q':
            print("Goodbye!")
            break
        elif choice == '1':
            text = input("Enter post text: ").strip()
            if text:
                create_post(text)
            else:
                print("[ERROR] Post text cannot be empty")
        elif choice == '2':
            text = input("Enter post text: ").strip()
            if not text:
                print("[ERROR] Post text cannot be empty")
                continue
            images_input = input("Enter image paths (comma-separated): ").strip()
            if images_input:
                images = [p.strip() for p in images_input.split(',') if p.strip()]
                create_post(text, images)
            else:
                print("[ERROR] At least one image is required")
        elif choice == '3':
            limit = input("Number of posts (default 20): ").strip()
            limit = int(limit) if limit else 20
            get_timeline(limit)
        elif choice == '4':
            limit = input("Number of posts (default 20): ").strip()
            limit = int(limit) if limit else 20
            get_timeline(limit, download_images=True)
        elif choice == '5':
            limit = input("Number of notifications (default 20): ").strip()
            limit = int(limit) if limit else 20
            get_notifications(limit)
        elif choice == '6':
            uri = input("Enter post URI: ").strip()
            if uri:
                like_post(uri)
            else:
                print("[ERROR] URI is required")
        elif choice == '7':
            uri = input("Enter post URI to repost: ").strip()
            if uri:
                repost_post(uri)
            else:
                print("[ERROR] URI is required")
        elif choice == '8':
            uri = input("Enter post URI to reply to: ").strip()
            text = input("Enter reply text: ").strip()
            if uri and text:
                reply_to_post(uri, text)
            else:
                print("[ERROR] URI and text are required")
        elif choice == '9':
            uri = input("Enter post URI to reply to: ").strip()
            text = input("Enter reply text: ").strip()
            if not uri or not text:
                print("[ERROR] URI and text are required")
                continue
            images_input = input("Enter image paths (comma-separated, or press Enter to skip): ").strip()
            if images_input:
                images = [p.strip() for p in images_input.split(',') if p.strip()]
                reply_to_post(uri, text, images)
            else:
                reply_to_post(uri, text)
        elif choice == '10':
            uri = input("Enter post URI to view thread: ").strip()
            depth = input("Thread depth (default 5): ").strip()
            depth = int(depth) if depth else 5
            if uri:
                get_thread(uri, depth)
            else:
                print("[ERROR] URI is required")
        elif choice == '11':
            uri = input("Enter post URI to view thread: ").strip()
            depth = input("Thread depth (default 5): ").strip()
            depth = int(depth) if depth else 5
            if uri:
                get_thread(uri, depth, download_images=True)
            else:
                print("[ERROR] URI is required")
        elif choice == '12':
            query = input("Enter search query: ").strip()
            limit = input("Number of results (default 20): ").strip()
            limit = int(limit) if limit else 20
            if query:
                search_posts(query, limit)
            else:
                print("[ERROR] Search query is required")
        elif choice == '13':
            handle = input("Enter handle (leave empty for your profile): ").strip()
            handle = handle or username
            if handle:
                get_profile(handle)
            else:
                print("[ERROR] Handle is required")
        elif choice == '14':
            handle = input("Enter user handle: ").strip()
            limit = input("Number of posts (default 20): ").strip()
            limit = int(limit) if limit else 20
            if handle:
                get_user_posts(handle, limit)
            else:
                print("[ERROR] Handle is required")
        elif choice == '15':
            list_chats()
        elif choice == '16':
            convo_id = input("Enter conversation ID: ").strip()
            limit = input("Number of messages (default 20): ").strip()
            limit = int(limit) if limit else 20
            if convo_id:
                get_chat_messages(convo_id, limit)
            else:
                print("[ERROR] Conversation ID is required")
        elif choice == '17':
            convo_id = input("Enter conversation ID: ").strip()
            text = input("Enter message text: ").strip()
            if convo_id and text:
                send_chat_message(convo_id, text)
            else:
                print("[ERROR] Conversation ID and text are required")
        elif choice == '18':
            handle = input("Enter handle to follow: ").strip()
            if handle:
                follow_user(handle)
            else:
                print("[ERROR] Handle is required")
        elif choice == '19':
            uri = input("Enter post URI to get likes: ").strip()
            limit = input("Number of likes (default 20): ").strip()
            limit = int(limit) if limit else 20
            if uri:
                get_likes_for_post(uri, limit)
            else:
                print("[ERROR] URI is required")
        elif choice == '20':
            uri = input("Enter post URI to download images: ").strip()
            output_dir = input("Output directory (default 'downloads'): ").strip()
            output_dir = output_dir or "downloads"
            if uri:
                download_post_images(uri, output_dir)
            else:
                print("[ERROR] URI is required")
        else:
            print("[ERROR] Invalid command. Try again.")
        
        print()


def main():
    parser = argparse.ArgumentParser(
        description="Bluesky CLI Bot - Interact with Bluesky from the command line",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bluesky-cli.py post "Hello World!"
  python bluesky-cli.py post "Check this out" --images photo1.jpg photo2.png
  python bluesky-cli.py timeline --limit 10
  python bluesky-cli.py timeline --download-images
  python bluesky-cli.py notifications
  python bluesky-cli.py like --uri "at://..."
  python bluesky-cli.py repost --uri "at://..."
  python bluesky-cli.py reply --uri "at://..." --text "Great post!"
  python bluesky-cli.py reply --uri "at://..." --text "Nice!" --images photo.jpg
  python bluesky-cli.py thread --uri "at://..."
  python bluesky-cli.py thread --uri "at://..." --download-images
  python bluesky-cli.py search --query "python"
  python bluesky-cli.py profile --handle "user.bsky.social"
  python bluesky-cli.py userposts --handle "user.bsky.social"
  python bluesky-cli.py userposts --handle "user.bsky.social" --download-images
  python bluesky-cli.py chats
  python bluesky-cli.py messages --convo-id "xxx"
  python bluesky-cli.py chatmsg --convo-id "xxx" --text "Hello!"
  python bluesky-cli.py follow --handle "user.bsky.social"
  python bluesky-cli.py postlikes --uri "at://..."
  python bluesky-cli.py download-images --uri "at://..."
  python bluesky-cli.py interactive
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Post command
    post_parser = subparsers.add_parser('post', help='Create a new post')
    post_parser.add_argument('text', type=str, help='Post text content')
    post_parser.add_argument('--images', type=str, nargs='+', help='Image file paths to attach')
    
    # Timeline command
    timeline_parser = subparsers.add_parser('timeline', help='View your timeline')
    timeline_parser.add_argument('--limit', type=int, default=20, help='Number of posts to fetch')
    timeline_parser.add_argument('--download-images', action='store_true', help='Download images from posts')
    
    # Notifications command
    notif_parser = subparsers.add_parser('notifications', help='View notifications')
    notif_parser.add_argument('--limit', type=int, default=20, help='Number of notifications to fetch')
    
    # Like command
    like_parser = subparsers.add_parser('like', help='Like a post')
    like_parser.add_argument('--uri', type=str, required=True, help='Post URI to like')
    
    # Repost command
    repost_parser = subparsers.add_parser('repost', help='Repost a post')
    repost_parser.add_argument('--uri', type=str, required=True, help='Post URI to repost')
    
    # Reply command
    reply_parser = subparsers.add_parser('reply', help='Reply to a post')
    reply_parser.add_argument('--uri', type=str, required=True, help='Post URI to reply to')
    reply_parser.add_argument('--text', type=str, required=True, help='Reply text')
    reply_parser.add_argument('--images', type=str, nargs='+', help='Image file paths to attach')
    
    # Thread command
    thread_parser = subparsers.add_parser('thread', help='View a thread')
    thread_parser.add_argument('--uri', type=str, required=True, help='Post URI to view thread')
    thread_parser.add_argument('--depth', type=int, default=5, help='Thread depth')
    thread_parser.add_argument('--download-images', action='store_true', help='Download images from posts')
    
    # Search command
    search_parser = subparsers.add_parser('search', help='Search posts')
    search_parser.add_argument('--query', type=str, required=True, help='Search query')
    search_parser.add_argument('--limit', type=int, default=20, help='Number of results')
    
    # Profile command
    profile_parser = subparsers.add_parser('profile', help='View a profile')
    profile_parser.add_argument('--handle', type=str, default=None, help='Handle to view')
    
    # User posts command
    userposts_parser = subparsers.add_parser('userposts', help='View user posts')
    userposts_parser.add_argument('--handle', type=str, required=True, help='User handle')
    userposts_parser.add_argument('--limit', type=int, default=20, help='Number of posts')
    userposts_parser.add_argument('--download-images', action='store_true', help='Download images from posts')
    
    # Chats command
    subparsers.add_parser('chats', help='List all chats')
    
    # Messages command
    messages_parser = subparsers.add_parser('messages', help='View chat messages')
    messages_parser.add_argument('--convo-id', type=str, required=True, help='Conversation ID')
    messages_parser.add_argument('--limit', type=int, default=20, help='Number of messages')
    
    # Chat message command
    chatmsg_parser = subparsers.add_parser('chatmsg', help='Send chat message')
    chatmsg_parser.add_argument('--convo-id', type=str, required=True, help='Conversation ID')
    chatmsg_parser.add_argument('--text', type=str, required=True, help='Message text')
    
    # Follow command
    follow_parser = subparsers.add_parser('follow', help='Follow a user')
    follow_parser.add_argument('--handle', type=str, required=True, help='Handle to follow')
    
    # Post likes command
    postlikes_parser = subparsers.add_parser('postlikes', help='Get post likes')
    postlikes_parser.add_argument('--uri', type=str, required=True, help='Post URI')
    postlikes_parser.add_argument('--limit', type=int, default=20, help='Number of likes to fetch')
    
    # Download images command
    download_parser = subparsers.add_parser('download-images', help='Download images from a post')
    download_parser.add_argument('--uri', type=str, required=True, help='Post URI')
    download_parser.add_argument('--output-dir', type=str, default='downloads', help='Output directory')
    
    # Interactive mode
    subparsers.add_parser('interactive', help='Interactive mode')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(0)
    
    if args.command == 'post':
        create_post(args.text, args.images)
    elif args.command == 'timeline':
        get_timeline(args.limit, download_images=args.download_images)
    elif args.command == 'notifications':
        get_notifications(args.limit)
    elif args.command == 'like':
        like_post(args.uri)
    elif args.command == 'repost':
        repost_post(args.uri)
    elif args.command == 'reply':
        reply_to_post(args.uri, args.text, args.images)
    elif args.command == 'thread':
        get_thread(args.uri, args.depth, download_images=args.download_images)
    elif args.command == 'search':
        search_posts(args.query, args.limit)
    elif args.command == 'profile':
        handle = args.handle
        if not handle:
            handle, _ = load_credentials()
        get_profile(handle)
    elif args.command == 'userposts':
        get_user_posts(args.handle, args.limit, download_images=args.download_images)
    elif args.command == 'chats':
        list_chats()
    elif args.command == 'messages':
        get_chat_messages(args.convo_id, args.limit)
    elif args.command == 'chatmsg':
        send_chat_message(args.convo_id, args.text)
    elif args.command == 'follow':
        follow_user(args.handle)
    elif args.command == 'postlikes':
        get_likes_for_post(args.uri, args.limit)
    elif args.command == 'download-images':
        download_post_images(args.uri, args.output_dir)
    elif args.command == 'interactive':
        interactive_mode()


if __name__ == "__main__":
    main()