import os
import json
import yaml
from typing import Any, Dict, Optional, List, cast

class Config:
    """Configuration system for proxy settings"""
    
    DEFAULT_CONFIG: Dict[str, Any] = {
        "storage_path": "proxies.json",
        "default_strategy": "round_robin",
        "max_failures": 10,
        "failure_threshold": 0.1,
        "test_url": "https://httpbin.org/ip",
        "test_timeout": 10,
        "proxies": []
    }
    
    def __init__(self, config_path: Optional[str] = None):
        self._config = self.DEFAULT_CONFIG.copy()
        if config_path:
            self.load_from_file(config_path)
        else:
            # Look for default config files
            for path in ["proxy_config.yaml", "proxy_config.yml", "proxy_config.json"]:
                if os.path.exists(path):
                    self.load_from_file(path)
                    break
                    
        self.load_from_env()
    
    def load_from_file(self, config_path: str):
        """Load configuration from a JSON or YAML file"""
        if not os.path.exists(config_path):
            return
            
        try:
            with open(config_path, 'r') as f:
                if config_path.endswith(('.yaml', '.yml')):
                    file_config = yaml.safe_load(f)
                else:
                    file_config = json.load(f)
            
            if file_config and isinstance(file_config, dict):
                self._config.update(file_config)
        except Exception as e:
            # Using print or logging? The project uses logging.
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error loading config from {config_path}: {e}")

    def load_from_env(self):
        """Override configuration with environment variables"""
        # Prefix: PROXY_
        env_mapping = {
            "PROXY_STORAGE_PATH": "storage_path",
            "PROXY_DEFAULT_STRATEGY": "default_strategy",
            "PROXY_MAX_FAILURES": "max_failures",
            "PROXY_FAILURE_THRESHOLD": "failure_threshold",
            "PROXY_TEST_URL": "test_url",
            "PROXY_TEST_TIMEOUT": "test_timeout"
        }
        
        for env_var, config_key in env_mapping.items():
            value = os.environ.get(env_var)
            if value is not None:
                # Type conversion based on default values
                default_val = self.DEFAULT_CONFIG.get(config_key)
                if isinstance(default_val, int):
                    try:
                        self._config[config_key] = int(value)
                    except ValueError:
                        pass
                elif isinstance(default_val, float):
                    try:
                        self._config[config_key] = float(value)
                    except ValueError:
                        pass
                else:
                    self._config[config_key] = value

    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value"""
        return self._config.get(key, default)

    @property
    def storage_path(self) -> str:
        return cast(str, self._config["storage_path"])

    @property
    def default_strategy(self) -> str:
        return cast(str, self._config["default_strategy"])

    @property
    def max_failures(self) -> int:
        return cast(int, self._config["max_failures"])

    @property
    def failure_threshold(self) -> float:
        return cast(float, self._config["failure_threshold"])

    @property
    def test_url(self) -> str:
        return cast(str, self._config["test_url"])

    @property
    def test_timeout(self) -> int:
        return cast(int, self._config["test_timeout"])
    
    @property
    def initial_proxies(self) -> List[Dict[str, Any]]:
        return cast(List[Dict[str, Any]], self._config.get("proxies", []))

# Global config instance
_config = None

def get_config(config_path: Optional[str] = None) -> Config:
    """Get or create global configuration"""
    global _config
    if _config is None or config_path is not None:
        _config = Config(config_path)
    return _config
