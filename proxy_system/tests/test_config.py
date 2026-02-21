import os
import json
import yaml
import pytest
from proxy_system.config import Config

def test_config_default_values():
    config = Config()
    assert config.storage_path == "proxies.json"
    assert config.default_strategy == "round_robin"
    assert config.max_failures == 10

def test_config_load_from_json(tmp_path):
    config_file = tmp_path / "config.json"
    config_data = {
        "storage_path": "custom_proxies.json",
        "max_failures": 5
    }
    with open(config_file, 'w') as f:
        json.dump(config_data, f)
    
    config = Config(str(config_file))
    assert config.storage_path == "custom_proxies.json"
    assert config.max_failures == 5
    assert config.default_strategy == "round_robin"  # Default remains

def test_config_load_from_yaml(tmp_path):
    config_file = tmp_path / "config.yaml"
    config_data = {
        "storage_path": "yaml_proxies.json",
        "max_failures": 3,
        "proxies": [
            {"host": "1.1.1.1", "port": 8080}
        ]
    }
    with open(config_file, 'w') as f:
        yaml.dump(config_data, f)
    
    config = Config(str(config_file))
    assert config.storage_path == "yaml_proxies.json"
    assert config.max_failures == 3
    assert len(config.initial_proxies) == 1
    assert config.initial_proxies[0]["host"] == "1.1.1.1"

def test_config_env_override(monkeypatch):
    monkeypatch.setenv("PROXY_STORAGE_PATH", "env_proxies.json")
    monkeypatch.setenv("PROXY_MAX_FAILURES", "20")
    
    config = Config()
    assert config.storage_path == "env_proxies.json"
    assert config.max_failures == 20

def test_config_env_override_types(monkeypatch):
    monkeypatch.setenv("PROXY_FAILURE_THRESHOLD", "0.5")
    monkeypatch.setenv("PROXY_MAX_FAILURES", "invalid")  # Should be ignored or handle gracefully
    
    config = Config()
    assert config.failure_threshold == 0.5
    assert config.max_failures == 10  # Remained default due to invalid int
