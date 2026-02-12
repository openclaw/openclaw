from proxy_system import Proxy, ProxyManager
from proxy_system.config import Config
import logging

def test_deactivation():
    config = Config()
    config._config['max_failures'] = 3
    config._config['failure_threshold'] = 0.5
    
    pm = ProxyManager(config=config)
    p1 = Proxy(id="p1", host="1.1.1.1", port=80)
    pm.add_proxy(p1)
    
    # 1st failure
    p1.mark_failure(max_failures=config.max_failures, failure_threshold=config.failure_threshold)
    assert p1.is_active == True
    
    # 2nd failure
    p1.mark_failure(max_failures=config.max_failures, failure_threshold=config.failure_threshold)
    assert p1.is_active == True
    
    # 3rd failure
    p1.mark_failure(max_failures=config.max_failures, failure_threshold=config.failure_threshold)
    assert p1.is_active == False
    print("Health check deactivation working correctly.")

if __name__ == "__main__":
    test_deactivation()
