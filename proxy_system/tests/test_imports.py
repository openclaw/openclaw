import importlib


def test_proxy_system_package_importable():
    module = importlib.import_module("proxy_system")
    assert hasattr(module, "Proxy")
    assert hasattr(module, "ProxyManager")
    assert hasattr(module, "get_proxy_manager")


def test_scraper_importable():
    scraper_module = importlib.import_module("proxy_system.scraper")
    assert hasattr(scraper_module, "ProxyScraper")
