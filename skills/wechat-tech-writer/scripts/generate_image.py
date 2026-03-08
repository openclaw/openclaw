#!/usr/bin/env python3
"""
图片生成API调用脚本

支持多种图片生成API:
- Gemini Imagen API (Google)
- DALL-E API (OpenAI)
- 其他自定义API

使用方法:
    python generate_image.py --prompt "图片描述" --api gemini --output output.png
    python generate_image.py --prompt "图片描述" --api dalle --output output.png
"""

import os
import sys
import argparse
import base64
import requests
from pathlib import Path
from typing import Optional, Dict, Any


class ImageGenerator:
    """图片生成器基类"""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or self._get_api_key()

    def _get_api_key(self) -> str:
        """从环境变量获取API密钥"""
        raise NotImplementedError

    def _get_proxies(self, proxy: Optional[str] = None) -> Optional[Dict[str, str]]:
        """获取代理配置"""
        # 优先使用命令行参数指定的代理
        if proxy:
            return {
                'http': proxy,
                'https': proxy
            }

        # 其次从环境变量读取
        http_proxy = os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy')
        https_proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')

        if http_proxy or https_proxy:
            return {
                'http': http_proxy or https_proxy,
                'https': https_proxy or http_proxy
            }

        return None

    def generate(self, prompt: str, output_path: str, **kwargs) -> str:
        """生成图片并保存"""
        raise NotImplementedError


class GeminiImageGenerator(ImageGenerator):
    """Gemini Imagen API图片生成器 - 使用 Google Genai SDK"""

    def _get_api_key(self) -> str:
        api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY')
        if not api_key:
            raise ValueError("请设置环境变量 GEMINI_API_KEY 或 GOOGLE_API_KEY")
        return api_key

    def generate(self, prompt: str, output_path: str, **kwargs) -> str:
        """
        使用 Google Genai SDK 生成图片

        参考: https://ai.google.dev/gemini-api/docs/image-generation
        """
        try:
            from google import genai
        except ImportError:
            raise ImportError("请先安装 google-genai SDK: pip install google-genai")

        try:
            # 创建客户端 - 环境变量中的代理会被自动使用
            client = genai.Client(api_key=self.api_key)

            # 使用图片生成模型
            model = kwargs.get("model", "gemini-3-pro-image-preview")

            # 生成图片
            response = client.models.generate_content(
                model=model,
                contents=[prompt],
            )

            # 处理响应并保存图片
            for part in response.parts:
                if part.inline_data is not None:
                    # 获取图片对象
                    image = part.as_image()
                    # 保存图片
                    image.save(output_path)
                    return output_path

            raise ValueError("API 响应中未找到图片数据")

        except Exception as e:
            raise RuntimeError(f"Gemini API调用失败: {str(e)}")


class DALLEImageGenerator(ImageGenerator):
    """DALL-E API图片生成器 (OpenAI)"""
    
    def _get_api_key(self) -> str:
        api_key = os.environ.get('OPENAI_API_KEY')
        if not api_key:
            raise ValueError("请设置环境变量 OPENAI_API_KEY")
        return api_key
    
    def generate(self, prompt: str, output_path: str, **kwargs) -> str:
        """
        使用DALL-E API生成图片
        
        参考: https://platform.openai.com/docs/api-reference/images
        """
        url = "https://api.openai.com/v1/images/generations"
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        
        # DALL-E 3参数
        data = {
            "model": kwargs.get("model", "dall-e-3"),
            "prompt": prompt,
            "n": 1,
            "size": kwargs.get("size", "1792x1024"),  # 16:9比例
            "quality": kwargs.get("quality", "standard"),  # standard 或 hd
            "response_format": "b64_json"  # 返回base64编码
        }

        # 配置代理
        proxies = self._get_proxies(kwargs.get("proxy"))

        try:
            response = requests.post(url, json=data, headers=headers, proxies=proxies, timeout=120)
            response.raise_for_status()
            
            result = response.json()
            
            # 提取图片数据
            if "data" in result and len(result["data"]) > 0:
                image_data = result["data"][0].get("b64_json")
                if image_data:
                    # 解码并保存图片
                    image_bytes = base64.b64decode(image_data)
                    with open(output_path, 'wb') as f:
                        f.write(image_bytes)
                    return output_path
            
            raise ValueError(f"API返回数据格式异常: {result}")
            
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"DALL-E API调用失败: {str(e)}")


class AnthropicImageGenerator(ImageGenerator):
    """Anthropic原生图片生成（通过Claude调用）"""
    
    def _get_api_key(self) -> str:
        # Claude环境下不需要单独的API key
        return "not_required"
    
    def generate(self, prompt: str, output_path: str, **kwargs) -> str:
        """
        使用Claude的原生图片生成能力
        
        注: 这个方法在claude.ai环境中可用
        """
        # 在claude.ai环境中，可以直接生成图片
        # 这里返回提示信息，实际生成由调用方处理
        return f"请使用Claude原生能力生成图片: {prompt}"


# API映射
API_GENERATORS = {
    "gemini": GeminiImageGenerator,
    "imagen": GeminiImageGenerator,  # 别名
    "dalle": DALLEImageGenerator,
    "openai": DALLEImageGenerator,  # 别名
    "anthropic": AnthropicImageGenerator,
    "claude": AnthropicImageGenerator,  # 别名
}


def main():
    parser = argparse.ArgumentParser(
        description="调用生图API生成图片",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        "--prompt",
        required=True,
        help="图片生成提示词"
    )
    
    parser.add_argument(
        "--api",
        choices=list(API_GENERATORS.keys()),
        default="gemini",
        help="使用的API (默认: gemini)"
    )
    
    parser.add_argument(
        "--output",
        required=True,
        help="输出图片路径"
    )
    
    parser.add_argument(
        "--aspect-ratio",
        default="16:9",
        help="图片宽高比 (默认: 16:9)"
    )
    
    parser.add_argument(
        "--size",
        help="图片尺寸 (DALL-E专用, 如: 1792x1024)"
    )
    
    parser.add_argument(
        "--quality",
        choices=["standard", "hd"],
        default="standard",
        help="图片质量 (DALL-E专用)"
    )

    parser.add_argument(
        "--proxy",
        help="代理地址 (如: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080)"
    )

    args = parser.parse_args()
    
    # 创建输出目录
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # 获取生成器类
    generator_class = API_GENERATORS[args.api]
    
    try:
        # 创建生成器实例
        generator = generator_class()
        
        # 准备参数
        kwargs = {
            "aspect_ratio": args.aspect_ratio,
        }

        # 添加代理配置
        if args.proxy:
            kwargs["proxy"] = args.proxy

        if args.api in ["dalle", "openai"]:
            if args.size:
                kwargs["size"] = args.size
            kwargs["quality"] = args.quality
        
        # 生成图片
        print(f"🎨 使用 {args.api.upper()} API生成图片...")
        print(f"📝 提示词: {args.prompt}")
        
        result_path = generator.generate(
            prompt=args.prompt,
            output_path=str(output_path),
            **kwargs
        )
        
        if args.api in ["anthropic", "claude"]:
            print(f"ℹ️  {result_path}")
            return 1
        
        print(f"✅ 图片已生成: {result_path}")
        return 0
        
    except Exception as e:
        print(f"❌ 生成失败: {str(e)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
