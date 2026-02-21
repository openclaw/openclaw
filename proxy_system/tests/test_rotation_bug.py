import pytest
from proxy_system import Proxy, ProxyManager, get_proxy_manager
from proxy_system.scraper import ProxyScraper
from unittest.mock import MagicMock, patch

def test_proxy_rotation_consistency():
    # Setup ProxyManager with 2 proxies
    pm = ProxyManager(storage_path="test_rotation.json")
    pm.proxies = {} # Clear existing
    p1 = Proxy(id="p1", host="1.1.1.1", port=80)
    p2 = Proxy(id="p2", host="2.2.2.2", port=80)
    pm.add_proxy(p1)
    pm.add_proxy(p2)
    
    # We want to see if ProxyScraper gets the same proxy for the request and for marking success/failure
    scraper = ProxyScraper()
    scraper.proxy_manager = pm # Use our local pm
    
    # We want to check if the proxy used in the request is the same as the one marked
    with patch('requests.Session.get') as mock_get:
        mock_get.return_value.status_code = 200
        
        # We need to control the rotation
        # get_proxy_for_request calls get_proxy once
        # Then get_with_proxy calls get_proxy AGAIN
        with patch.object(pm, 'get_proxy', side_effect=[p1, p2]):
            scraper.get_with_proxy("http://example.com")
            
            # Check request proxy
            _, kwargs = mock_get.call_args
            assert kwargs['proxies']['http'] == p1.url
            
            # Check which one was marked. It should be p1.
            # But the bug says it will mark p2.
            print(f"P1 success count: {p1.success_count}")
            print(f"P2 success count: {p2.success_count}")
            
            assert p1.success_count == 1
            assert p2.success_count == 0

if __name__ == "__main__":
    test_proxy_rotation_consistency()
