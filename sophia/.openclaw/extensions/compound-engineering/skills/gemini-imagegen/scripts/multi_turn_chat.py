#!/usr/bin/env python3
"""
Interactive multi-turn image generation and refinement using Gemini API.

Usage:
    python multi_turn_chat.py [--model MODEL] [--output-dir DIR]

This starts an interactive session where you can:
- Generate images from prompts
- Iteratively refine images through conversation
- Load existing images for editing
- Save images at any point

Commands:
    /save [filename]  - Save current image
    /load <path>      - Load an image into the conversation
    /clear            - Start fresh conversation
    /quit             - Exit

Environment:
    GEMINI_API_KEY - Required API key
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image
from google import genai
from google.genai import types


class ImageChat:
    """Interactive chat session for image generation and refinement."""
    
    def __init__(
        self,
        model: str = "gemini-2.5-flash-image",
        output_dir: str = ".",
    ):
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise EnvironmentError("GEMINI_API_KEY environment variable not set")
        
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.chat = None
        self.current_image = None
        self.image_count = 0
        
        self._init_chat()
    
    def _init_chat(self):
        """Initialize or reset the chat session."""
        config = types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"]
        )
        self.chat = self.client.chats.create(
            model=self.model,
            config=config,
        )
        self.current_image = None
    
    def send_message(self, message: str, image: Image.Image | None = None) -> tuple[str | None, Image.Image | None]:
        """Send a message and optionally an image, return response text and image."""
        contents = []
        if message:
            contents.append(message)
        if image:
            contents.append(image)
        
        if not contents:
            return None, None
        
        response = self.chat.send_message(contents)
        
        text_response = None
        image_response = None
        
        for part in response.parts:
            if part.text is not None:
                text_response = part.text
            elif part.inline_data is not None:
                image_response = part.as_image()
                self.current_image = image_response
        
        return text_response, image_response
    
    def save_image(self, filename: str | None = None) -> str | None:
        """Save the current image to a file."""
        if self.current_image is None:
            return None
        
        if filename is None:
            self.image_count += 1
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"image_{timestamp}_{self.image_count}.png"
        
        filepath = self.output_dir / filename
        self.current_image.save(filepath)
        return str(filepath)
    
    def load_image(self, path: str) -> Image.Image:
        """Load an image from disk."""
        img = Image.open(path)
        self.current_image = img
        return img


def main():
    parser = argparse.ArgumentParser(
        description="Interactive multi-turn image generation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        "--model", "-m",
        default="gemini-2.5-flash-image",
        choices=["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
        help="Model to use"
    )
    parser.add_argument(
        "--output-dir", "-o",
        default=".",
        help="Directory to save images"
    )
    
    args = parser.parse_args()
    
    try:
        chat = ImageChat(model=args.model, output_dir=args.output_dir)
    except Exception as e:
        print(f"Error initializing: {e}", file=sys.stderr)
        sys.exit(1)
    
    print(f"Gemini Image Chat ({args.model})")
    print("Commands: /save [name], /load <path>, /clear, /quit")
    print("-" * 50)
    
    while True:
        try:
            user_input = input("\nYou: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break
        
        if not user_input:
            continue
        
        # Handle commands
        if user_input.startswith("/"):
            parts = user_input.split(maxsplit=1)
            cmd = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else None
            
            if cmd == "/quit":
                print("Goodbye!")
                break
            
            elif cmd == "/clear":
                chat._init_chat()
                print("Conversation cleared.")
                continue
            
            elif cmd == "/save":
                path = chat.save_image(arg)
                if path:
                    print(f"Image saved to: {path}")
                else:
                    print("No image to save.")
                continue
            
            elif cmd == "/load":
                if not arg:
                    print("Usage: /load <path>")
                    continue
                try:
                    chat.load_image(arg)
                    print(f"Loaded: {arg}")
                    print("You can now describe edits to make.")
                except Exception as e:
                    print(f"Error loading image: {e}")
                continue
            
            else:
                print(f"Unknown command: {cmd}")
                continue
        
        # Send message to model
        try:
            # If we have a loaded image and this is first message, include it
            image_to_send = None
            if chat.current_image and not chat.chat.history:
                image_to_send = chat.current_image
            
            text, image = chat.send_message(user_input, image_to_send)
            
            if text:
                print(f"\nGemini: {text}")
            
            if image:
                # Auto-save
                path = chat.save_image()
                print(f"\n[Image generated: {path}]")
            
        except Exception as e:
            print(f"\nError: {e}")


if __name__ == "__main__":
    main()
