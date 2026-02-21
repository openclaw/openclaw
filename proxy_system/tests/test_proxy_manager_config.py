import os
import pytest
from proxy_system import ProxyManager, get_proxy_manager
from proxy_system.config import Config

def test_proxy_manager_uses_config():
    config = Config()
    # Mock some values
    config._config["storage_path"] = "test_storage.json"
    config._config["default_strategy"] = "random"
    
    pm = ProxyManager(config=config)
    assert pm.storage_path == "test_storage.json"
    
    # Test that get_proxy uses the default strategy from config
    # We need some proxies first
    from proxy_system import Proxy
    pm.add_proxy(Proxy(id="p1", host="1.1.1.1", port=80))
    pm.add_proxy(Proxy(id="p2", host="2.2.2.2", port=80))
    
    # This should call get_proxy(strategy="random") internally if no strategy provided
    proxy = pm.get_proxy()
    assert proxy is not None

def test_proxy_manager_initial_proxies(tmp_path):
    config_file = tmp_path / "config.yaml"
    import yaml
    config_data = {
        "proxies": [
            {"host": "3.3.3.3", "port": 8080},
            {"host": "4.4.4.4", "port": 8080, "id": "custom_id"}
        ]
    }
    with open(config_file, 'w') as f:
        yaml.dump(config_data, f)
    
    config = Config(str(config_file))
    pm = ProxyManager(storage_path=str(tmp_path / "pm_storage.json"), config=config)
    
    assert len(pm.proxies) == 2
    assert "3.3.3.3:8080" in pm.proxies
    assert "custom_id" in pm.proxies
