"""
Proxy Management System for Bank Enrichment
- Store and rotate proxies
- Track proxy health and success rates
- Integrate with scraping tools
"""

import os
import json
import time
import random
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
import logging

from .config import Config, get_config

logger = logging.getLogger(__name__)

@dataclass
class Proxy:
    """Proxy configuration"""
    id: str
    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    protocol: str = "http"  # http, https, socks4, socks5
    country: Optional[str] = None
    provider: Optional[str] = None
    is_active: bool = True
    success_count: int = 0
    failure_count: int = 0
    last_used: Optional[datetime] = None
    last_success: Optional[datetime] = None
    created_at: Optional[datetime] = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate"""
        total = self.success_count + self.failure_count
        return self.success_count / total if total > 0 else 0.0
    
    @property
    def url(self) -> str:
        """Get proxy URL"""
        if self.username and self.password:
            return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"
        return f"{self.protocol}://{self.host}:{self.port}"
    
    def mark_success(self):
        """Mark proxy as successful"""
        self.success_count += 1
        self.last_success = datetime.now()
        self.last_used = datetime.now()
    
    def mark_failure(self, max_failures: int = 10, failure_threshold: float = 0.1):
        """Mark proxy as failed"""
        self.failure_count += 1
        self.last_used = datetime.now()
        
        # Deactivate if too many failures
        if self.failure_count >= max_failures and self.success_rate < failure_threshold:
            self.is_active = False
            logger.warning(f"Proxy {self.id} deactivated due to poor performance")

class ProxyManager:
    """Manage proxy rotation and selection"""
    
    def __init__(self, storage_path: Optional[str] = None, config: Optional[Config] = None):
        self.config = config or get_config()
        self.storage_path = storage_path or self.config.storage_path
        self.proxies: Dict[str, Proxy] = {}
        self.load_proxies()
        
        # Add initial proxies from config if any
        self._add_initial_proxies()
    
    def _add_initial_proxies(self):
        """Add proxies defined in configuration"""
        for p_data in self.config.initial_proxies:
            # Ensure id exists
            if 'id' not in p_data:
                p_data['id'] = f"{p_data['host']}:{p_data['port']}"
            
            if p_data['id'] not in self.proxies:
                # Basic validation
                if 'host' in p_data and 'port' in p_data:
                    proxy = Proxy(**p_data)
                    self.add_proxy(proxy)
    
    def load_proxies(self):
        """Load proxies from storage"""
        if os.path.exists(self.storage_path):
            try:
                with open(self.storage_path, 'r') as f:
                    data = json.load(f)
                
                for proxy_data in data.get('proxies', []):
                    # Convert string dates back to datetime
                    for date_field in ['last_used', 'last_success', 'created_at']:
                        if proxy_data.get(date_field):
                            proxy_data[date_field] = datetime.fromisoformat(proxy_data[date_field])
                    
                    proxy = Proxy(**proxy_data)
                    self.proxies[proxy.id] = proxy
                
                logger.info(f"Loaded {len(self.proxies)} proxies from {self.storage_path}")
            except Exception as e:
                logger.error(f"Error loading proxies: {e}")
                self.proxies = {}
        else:
            logger.info(f"No proxy storage found at {self.storage_path}")
    
    def save_proxies(self):
        """Save proxies to storage"""
        try:
            # Convert proxies to serializable format
            proxies_data = []
            for proxy in self.proxies.values():
                proxy_dict = asdict(proxy)
                # Convert datetime to string
                for date_field in ['last_used', 'last_success', 'created_at']:
                    if proxy_dict.get(date_field):
                        proxy_dict[date_field] = proxy_dict[date_field].isoformat()
                proxies_data.append(proxy_dict)
            
            data = {
                'proxies': proxies_data,
                'updated_at': datetime.now().isoformat()
            }
            
            # Ensure directory exists
            if os.path.dirname(self.storage_path):
                os.makedirs(os.path.dirname(self.storage_path), exist_ok=True)
            
            with open(self.storage_path, 'w') as f:
                json.dump(data, f, indent=2)
            
            logger.info(f"Saved {len(self.proxies)} proxies to {self.storage_path}")
        except Exception as e:
            logger.error(f"Error saving proxies: {e}")
    
    def add_proxy(self, proxy: Proxy):
        """Add a new proxy"""
        self.proxies[proxy.id] = proxy
        self.save_proxies()
        logger.info(f"Added proxy {proxy.id}: {proxy.host}:{proxy.port}")
    
    def remove_proxy(self, proxy_id: str):
        """Remove a proxy"""
        if proxy_id in self.proxies:
            del self.proxies[proxy_id]
            self.save_proxies()
            logger.info(f"Removed proxy {proxy_id}")
    
    def get_proxy(self, strategy: Optional[str] = None) -> Optional[Proxy]:
        """Get a proxy based on selection strategy"""
        strategy = strategy or self.config.default_strategy
        active_proxies = [p for p in self.proxies.values() if p.is_active]
        
        if not active_proxies:
            logger.warning("No active proxies available")
            return None
        
        if strategy == "random":
            return random.choice(active_proxies)
        
        elif strategy == "round_robin":
            # Sort by last used (oldest first)
            active_proxies.sort(key=lambda p: p.last_used or datetime.min)
            return active_proxies[0]
        
        elif strategy == "success_rate":
            # Sort by success rate (highest first)
            active_proxies.sort(key=lambda p: p.success_rate, reverse=True)
            return active_proxies[0]
        
        else:
            logger.warning(f"Unknown proxy strategy: {strategy}, using random")
            return random.choice(active_proxies)
    
    def get_proxy_for_request(self, target_url: Optional[str] = None) -> Optional[Dict]:
        """Get proxy configuration for requests library"""
        proxy = self.get_proxy()
        if not proxy:
            return None
        
        # Prepare proxy dict for requests
        proxy_dict = {
            'http': proxy.url,
            'https': proxy.url
        }
        
        return proxy_dict
    
    def test_proxy(self, proxy_id: str, test_url: Optional[str] = None) -> bool:
        """Test if a proxy is working"""
        import requests
        
        test_url = test_url or self.config.test_url
        timeout = self.config.test_timeout
        
        proxy = self.proxies.get(proxy_id)
        if not proxy:
            logger.error(f"Proxy {proxy_id} not found")
            return False
        
        try:
            proxies = {
                'http': proxy.url,
                'https': proxy.url
            }
            
            response = requests.get(test_url, proxies=proxies, timeout=timeout)
            if response.status_code == 200:
                proxy.mark_success()
                logger.info(f"Proxy {proxy_id} test successful: {response.json()}")
                return True
            else:
                proxy.mark_failure(
                    max_failures=self.config.max_failures,
                    failure_threshold=self.config.failure_threshold
                )
                logger.warning(f"Proxy {proxy_id} test failed with status {response.status_code}")
                return False
                
        except Exception as e:
            proxy.mark_failure(
                max_failures=self.config.max_failures,
                failure_threshold=self.config.failure_threshold
            )
            logger.error(f"Proxy {proxy_id} test error: {e}")
            return False
        finally:
            self.save_proxies()
    
    def bulk_test_proxies(self, test_url: Optional[str] = None):
        """Test all active proxies"""
        test_url = test_url or self.config.test_url
        logger.info(f"Testing {len(self.proxies)} proxies...")
        
        results = []
        for proxy_id, proxy in self.proxies.items():
            if proxy.is_active:
                success = self.test_proxy(proxy_id, test_url)
                results.append((proxy_id, success))
        
        successful = sum(1 for _, success in results if success)
        logger.info(f"Proxy test complete: {successful}/{len(results)} successful")
        return results
    
    def import_from_file(self, file_path: str, format: str = "txt"):
        """Import proxies from a file"""
        try:
            with open(file_path, 'r') as f:
                content = f.read().strip()
            
            proxies_added = 0
            
            if format == "txt":
                # Format: host:port or host:port:username:password
                for line in content.split('\n'):
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    
                    parts = line.split(':')
                    if len(parts) >= 2:
                        host = parts[0]
                        port = int(parts[1])
                        username = parts[2] if len(parts) > 2 else None
                        password = parts[3] if len(parts) > 3 else None
                        
                        proxy_id = f"{host}:{port}"
                        proxy = Proxy(
                            id=proxy_id,
                            host=host,
                            port=port,
                            username=username,
                            password=password
                        )
                        
                        self.add_proxy(proxy)
                        proxies_added += 1
            
            logger.info(f"Imported {proxies_added} proxies from {file_path}")
            return proxies_added
            
        except Exception as e:
            logger.error(f"Error importing proxies from {file_path}: {e}")
            return 0
    
    def get_stats(self) -> Dict:
        """Get proxy statistics"""
        active = sum(1 for p in self.proxies.values() if p.is_active)
        total = len(self.proxies)
        
        if total > 0:
            avg_success_rate = sum(p.success_rate for p in self.proxies.values()) / total
        else:
            avg_success_rate = 0
        
        return {
            'total_proxies': total,
            'active_proxies': active,
            'inactive_proxies': total - active,
            'avg_success_rate': avg_success_rate,
            'total_requests': sum(p.success_count + p.failure_count for p in self.proxies.values())
        }

# Global proxy manager instance
proxy_manager = None

def get_proxy_manager(storage_path: Optional[str] = None, config: Optional[Config] = None) -> ProxyManager:
    """Get or create global proxy manager"""
    global proxy_manager
    if proxy_manager is None:
        proxy_manager = ProxyManager(storage_path, config)
    return proxy_manager
