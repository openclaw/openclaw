#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Multi-Search Skill - 智能多引擎搜索
自动按优先级切换：DuckDuckGo -> Tavily -> Bing API -> Bing爬虫
自动检测网络环境，智能选择可用引擎
"""

import os
import sys
import json
import re
import html
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from urllib.parse import quote

if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.detach())

QUOTA_FILE = os.path.join(os.path.dirname(__file__), "quota.json")
NETWORK_CACHE_FILE = os.path.join(os.path.dirname(__file__), "network_cache.json")
API_KEYS_FILE = os.path.join(os.path.dirname(__file__), "api_keys.json")
MAX_TAVILY_QUOTA = 1000
MAX_BING_API_QUOTA = 1000
NETWORK_CHECK_INTERVAL = 300

def get_api_key(service: str) -> Optional[str]:
    """从环境变量或配置文件获取 API key"""
    env_key = os.environ.get(f'{service}_API_KEY')
    if env_key:
        return env_key
    
    if os.path.exists(API_KEYS_FILE):
        try:
            with open(API_KEYS_FILE, 'r', encoding='utf-8') as f:
                keys = json.load(f)
                return keys.get(service.lower())
        except:
            pass
    return None


class NetworkChecker:
    """网络环境检测器 - 检测各引擎可用性"""
    
    def __init__(self):
        self.cache = self._load_cache()
    
    def _load_cache(self) -> Dict:
        """加载网络检测缓存"""
        if os.path.exists(NETWORK_CACHE_FILE):
            try:
                with open(NETWORK_CACHE_FILE, 'r', encoding='utf-8') as f:
                    cache = json.load(f)
                    last_check = datetime.fromisoformat(cache.get('last_check', '2000-01-01'))
                    if (datetime.now() - last_check).seconds < NETWORK_CHECK_INTERVAL:
                        return cache
            except:
                pass
        return {'availability': {}, 'last_check': datetime.now().isoformat()}
    
    def _save_cache(self):
        """保存网络检测缓存"""
        try:
            self.cache['last_check'] = datetime.now().isoformat()
            with open(NETWORK_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.cache, f, indent=2)
        except Exception as e:
            print(f"[WARN] Failed to save network cache: {e}")
    
    def check_duckduckgo(self, force: bool = False) -> bool:
        """检测 DuckDuckGo 是否可用"""
        if not force and 'duckduckgo' in self.cache['availability']:
            return self.cache['availability']['duckduckgo']
        
        try:
            import requests
            response = requests.get(
                'https://duckduckgo.com/html/?q=test',
                timeout=5,
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
            )
            available = response.status_code == 200
            self.cache['availability']['duckduckgo'] = available
            self._save_cache()
            return available
        except:
            self.cache['availability']['duckduckgo'] = False
            self._save_cache()
            return False
    
    def check_bing(self, force: bool = False) -> bool:
        """检测 Bing 是否可用"""
        if not force and 'bing' in self.cache['availability']:
            return self.cache['availability']['bing']
        
        try:
            import requests
            response = requests.get(
                'https://www.bing.com',
                timeout=5,
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
            )
            available = response.status_code == 200
            self.cache['availability']['bing'] = available
            self._save_cache()
            return available
        except:
            self.cache['availability']['bing'] = False
            self._save_cache()
            return False
    
    def check_tavily(self, force: bool = False) -> bool:
        """检测 Tavily API 是否可用（需要配置 API key）"""
        api_key = get_api_key('TAVILY')
        if not api_key:
            return False
        
        if not force and 'tavily' in self.cache['availability']:
            return self.cache['availability']['tavily']
        
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=api_key)
            response = client.search(query='test', max_results=1)
            available = len(response.get('results', [])) >= 0
            self.cache['availability']['tavily'] = available
            self._save_cache()
            return available
        except:
            self.cache['availability']['tavily'] = False
            self._save_cache()
            return False
    
    def get_availability(self, force_check: bool = False) -> Dict[str, bool]:
        """获取所有引擎的可用性状态"""
        return {
            'duckduckgo': self.check_duckduckgo(force_check),
            'bing': self.check_bing(force_check),
            'tavily': self.check_tavily(force_check)
        }


class QuotaManager:
    """管理 API 使用配额"""
    
    def __init__(self):
        self.quota_data = self._load_quota()
    
    def _load_quota(self) -> Dict:
        """加载配额数据"""
        if os.path.exists(QUOTA_FILE):
            try:
                with open(QUOTA_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {
            "tavily": {"used": 0, "month": datetime.now().month},
            "bing_api": {"used": 0, "month": datetime.now().month},
            "last_reset": datetime.now().isoformat()
        }
    
    def _save_quota(self):
        """保存配额数据"""
        try:
            with open(QUOTA_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.quota_data, f, indent=2)
        except Exception as e:
            print(f"[WARN] Failed to save quota: {e}")
    
    def _check_month_reset(self):
        """检查是否需要月度重置"""
        current_month = datetime.now().month
        for service in ["tavily", "bing_api"]:
            if self.quota_data[service]["month"] != current_month:
                self.quota_data[service]["used"] = 0
                self.quota_data[service]["month"] = current_month
                print(f"[INFO] Reset {service} quota for new month")
        self._save_quota()
    
    def use_quota(self, service: str) -> bool:
        """使用一次配额，返回是否成功"""
        self._check_month_reset()
        
        if service == "tavily":
            if self.quota_data["tavily"]["used"] < MAX_TAVILY_QUOTA:
                self.quota_data["tavily"]["used"] += 1
                self._save_quota()
                return True
        elif service == "bing_api":
            if self.quota_data["bing_api"]["used"] < MAX_BING_API_QUOTA:
                self.quota_data["bing_api"]["used"] += 1
                self._save_quota()
                return True
        
        return False
    
    def get_quota_status(self) -> Dict:
        """获取配额状态"""
        self._check_month_reset()
        return {
            "tavily": {
                "used": self.quota_data["tavily"]["used"],
                "limit": MAX_TAVILY_QUOTA,
                "remaining": MAX_TAVILY_QUOTA - self.quota_data["tavily"]["used"]
            },
            "bing_api": {
                "used": self.quota_data["bing_api"]["used"],
                "limit": MAX_BING_API_QUOTA,
                "remaining": MAX_BING_API_QUOTA - self.quota_data["bing_api"]["used"]
            }
        }


class SearchEngine:
    """搜索引擎基类"""
    
    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        raise NotImplementedError


class DuckDuckGoSearch(SearchEngine):
    """DuckDuckGo 搜索 - 无需 API Key"""
    
    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        """使用 DuckDuckGo 搜索"""
        try:
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS
            
            with DDGS() as ddgs:
                results = []
                for r in ddgs.text(query, max_results=max_results):
                    results.append({
                        'title': r.get('title', ''),
                        'href': r.get('href', ''),
                        'body': r.get('body', '')[:200] + "..." if len(r.get('body', '')) > 200 else r.get('body', ''),
                        'source': 'duckduckgo'
                    })
                return results
                
        except Exception as e:
            print(f"[ERROR] DuckDuckGo search failed: {e}")
            return []


class BingScraper(SearchEngine):
    """Bing 爬虫搜索 - 无需 API Key"""
    
    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        """使用 Bing 网页搜索"""
        try:
            import requests
            from bs4 import BeautifulSoup

            search_url = f"https://www.bing.com/search?q={quote(query)}"

            response = requests.get(search_url, timeout=15, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            })

            if response.status_code != 200:
                print(f"[ERROR] Bing scraper failed: {response.status_code}")
                return []

            soup = BeautifulSoup(response.text, 'html.parser')
            links = soup.find_all('a', href=True)

            results = []
            for link in links:
                href = link.get('href', '')
                text = link.get_text().strip()

                if not text or len(text) < 5:
                    continue
                if 'bing.com' in href or 'msn.com' in href:
                    continue
                if not href.startswith('http'):
                    continue

                results.append({
                    'title': text[:100],
                    'href': href,
                    'body': '',
                    'source': 'bing_scraper'
                })

                if len(results) >= max_results:
                    break

            return results

        except ImportError:
            print("[ERROR] BeautifulSoup not installed. Run: pip install beautifulsoup4")
            return []
        except Exception as e:
            print(f"[ERROR] Bing scraper failed: {e}")
            return []


class TavilySearch(SearchEngine):
    """Tavily API 搜索 - 需要 API Key"""
    
    def __init__(self):
        self.api_key = get_api_key('TAVILY')
    
    def is_available(self) -> bool:
        return self.api_key is not None
    
    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        """使用 Tavily API 搜索"""
        try:
            from tavily import TavilyClient
            
            client = TavilyClient(api_key=self.api_key)
            response = client.search(
                query=query,
                max_results=max_results,
                search_depth="basic"
            )
            
            results = []
            for item in response.get("results", []):
                results.append({
                    'title': item.get('title', ''),
                    'href': item.get('url', ''),
                    'body': item.get('content', '')[:200] + "..." if len(item.get('content', '')) > 200 else item.get('content', ''),
                    'source': 'tavily'
                })
            
            return results
            
        except Exception as e:
            print(f"[ERROR] Tavily search failed: {e}")
            return []


class BingAPISearch(SearchEngine):
    """Bing Web Search API - 需要 API Key"""
    
    def __init__(self):
        self.api_key = os.environ.get("BING_API_KEY")
        self.endpoint = "https://api.bing.microsoft.com/v7.0/search"
    
    def is_available(self) -> bool:
        return self.api_key is not None
    
    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        """使用 Bing Web Search API"""
        try:
            import requests
            
            headers = {"Ocp-Apim-Subscription-Key": self.api_key}
            params = {
                "q": query,
                "count": max_results,
                "textDecorations": False,
                "textFormat": "HTML"
            }
            
            response = requests.get(self.endpoint, headers=headers, params=params)
            response.raise_for_status()
            
            search_results = response.json()
            results = []
            
            for item in search_results.get("webPages", {}).get("value", []):
                results.append({
                    'title': item.get('name', ''),
                    'href': item.get('url', ''),
                    'body': item.get('snippet', ''),
                    'source': 'bing_api'
                })
            
            return results
            
        except Exception as e:
            print(f"[ERROR] Bing API search failed: {e}")
            return []


class MultiSearch:
    """多引擎搜索管理器"""
    
    def __init__(self):
        self.quota_manager = QuotaManager()
        self.network_checker = NetworkChecker()
        self.duckduckgo = DuckDuckGoSearch()
        self.bing_scraper = BingScraper()
        self.tavily = TavilySearch()
        self.bing_api = BingAPISearch()
    
    def search(self, query: str, max_results: int = 5, prefer_quality: bool = False, force_network_check: bool = False) -> List[Dict]:
        """
        智能搜索 - 自动选择最佳引擎
        
        Args:
            query: 搜索关键词
            max_results: 最大结果数
            prefer_quality: 是否优先质量（优先使用 Tavily）
            force_network_check: 是否强制重新检测网络
        
        Returns:
            搜索结果列表
        """
        print("=" * 60)
        print("🔍 Multi-Search - 智能多引擎搜索")
        print("=" * 60)
        print(f"[Query] {query}")
        print(f"[Mode] {'Quality Priority' if prefer_quality else 'Balanced'}")
        print("-" * 60)
        
        print("[Network] Checking availability...")
        availability = self.network_checker.get_availability(force_check=force_network_check)
        print(f"  DuckDuckGo: {'✅' if availability['duckduckgo'] else '❌'}")
        print(f"  Bing: {'✅' if availability['bing'] else '❌'}")
        print(f"  Tavily: {'✅' if availability['tavily'] else '❌'}")
        print("-" * 60)
        
        quota_status = self.quota_manager.get_quota_status()
        print(f"[Quota] Tavily: {quota_status['tavily']['remaining']}/{MAX_TAVILY_QUOTA} remaining")
        print(f"[Quota] Bing API: {quota_status['bing_api']['remaining']}/{MAX_BING_API_QUOTA} remaining")
        print("-" * 60)
        
        results = []
        used_engine = ""
        
        if prefer_quality and availability['tavily'] and quota_status['tavily']['remaining'] > 0:
            print("[Strategy] Quality first: Trying Tavily...")
            if self.quota_manager.use_quota("tavily"):
                results = self.tavily.search(query, max_results)
                used_engine = "Tavily"
        
        if not results and availability['duckduckgo']:
            print("[Strategy] Trying DuckDuckGo...")
            results = self.duckduckgo.search(query, max_results)
            used_engine = "DuckDuckGo"
        
        if not results and self.bing_api.is_available() and quota_status['bing_api']['remaining'] > 0:
            print("[Strategy] Trying Bing Web Search API...")
            if self.quota_manager.use_quota("bing_api"):
                results = self.bing_api.search(query, max_results)
                used_engine = "Bing API"
        
        if not results and availability['bing']:
            print("[Strategy] Using Bing Scraper (fallback)...")
            results = self.bing_scraper.search(query, max_results)
            used_engine = "Bing Scraper"
        
        if results:
            print(f"\n[OK] {used_engine} returned {len(results)} results:\n")
            for idx, r in enumerate(results, 1):
                print(f"{idx}. {r['title']}")
                print(f"   Source: {r['source']}")
                print(f"   URL: {r['href']}")
                if r['body']:
                    print(f"   Summary: {r['body'][:150]}...")
                print()
        else:
            print("[ERROR] All search engines failed")
            print("[TIP] Try enabling VPN or check your network connection")
        
        print("=" * 60)
        return results
    
    def get_status(self, force_network_check: bool = False) -> Dict:
        """获取搜索系统状态"""
        quota = self.quota_manager.get_quota_status()
        availability = self.network_checker.get_availability(force_check=force_network_check)
        
        return {
            "quota": quota,
            "network": availability,
            "engines": {
                "duckduckgo": {"available": availability['duckduckgo'], "type": "unlimited"},
                "bing_scraper": {"available": availability['bing'], "type": "unlimited"},
                "tavily": {"available": availability['tavily'], "type": "api"},
                "bing_api": {"available": self.bing_api.is_available(), "type": "api"}
            }
        }


def search(query: str, max_results: int = 5, prefer_quality: bool = False, force_network_check: bool = False) -> List[Dict]:
    """
    执行多引擎搜索
    
    Args:
        query: 搜索关键词
        max_results: 最大结果数
        prefer_quality: 是否优先质量（会优先使用 Tavily）
        force_network_check: 是否强制重新检测网络
    
    Returns:
        搜索结果列表
    """
    multi_search = MultiSearch()
    return multi_search.search(query, max_results, prefer_quality, force_network_check)


def search_skills(query: str = "OpenClaw AI agent skills", max_results: int = 10, force_network_check: bool = False) -> List[Dict]:
    """搜索 OpenClaw/AI Agent 相关技能"""
    return search(query, max_results, prefer_quality=True, force_network_check=force_network_check)


def get_status(force_network_check: bool = False):
    """获取搜索系统状态"""
    multi_search = MultiSearch()
    status = multi_search.get_status(force_network_check=force_network_check)
    
    print("=" * 60)
    print("📊 Multi-Search System Status")
    print("=" * 60)
    
    print("\n[Network Status]")
    for engine, available in status["network"].items():
        status_icon = "✅" if available else "❌"
        print(f"  {status_icon} {engine}")
    
    print("\n[Quota Status]")
    for service, info in status["quota"].items():
        print(f"  {service}: {info['used']}/{info['limit']} used, {info['remaining']} remaining")
    
    print("\n[Engine Status]")
    for engine, info in status["engines"].items():
        status_icon = "✅" if info["available"] else "❌"
        print(f"  {status_icon} {engine} ({info['type']})")
    
    print("=" * 60)
    return status


class WebContentFetcher:
    """网页内容抓取器"""
    
    def __init__(self, timeout: int = 15):
        self.timeout = timeout
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        }
    
    def fetch(self, url: str, max_length: int = 5000) -> Dict:
        """抓取网页内容"""
        try:
            import requests
            from bs4 import BeautifulSoup
            
            response = requests.get(url, timeout=self.timeout, headers=self.headers)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            for script in soup(["script", "style", "nav", "footer", "header"]):
                script.decompose()
            
            title = soup.title.string if soup.title else ""
            
            text = soup.get_text(separator='\n', strip=True)
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            content = '\n'.join(lines)
            
            if len(content) > max_length:
                content = content[:max_length] + "..."
            
            return {
                'title': title,
                'content': content,
                'url': url,
                'success': True
            }
            
        except Exception as e:
            return {
                'title': '',
                'content': '',
                'url': url,
                'success': False,
                'error': str(e)
            }


def fetch_web_content(url: str, max_length: int = 5000) -> Dict:
    """抓取网页内容的便捷函数"""
    fetcher = WebContentFetcher()
    return fetcher.fetch(url, max_length)


def fetch_search_results_content(results: List[Dict], max_length: int = 2000) -> List[Dict]:
    """批量抓取搜索结果的详细内容"""
    fetcher = WebContentFetcher()
    enriched = []
    
    for result in results:
        enriched_result = result.copy()
        if result.get('href'):
            content = fetcher.fetch(result['href'], max_length)
            if content['success']:
                enriched_result['full_content'] = content
        enriched.append(enriched_result)
    
    return enriched


if __name__ == "__main__":
    print("Multi-Search Skill - 智能多引擎搜索")
    print("Usage: from multi_search import search, get_status")
    
    demo = False
    if demo:
        search("Python tutorial", max_results=3)
        search("OpenClaw AI agent skills 2025", max_results=3, force_network_check=True)
