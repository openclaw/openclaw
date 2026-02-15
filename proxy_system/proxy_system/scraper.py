"""
Proxy-Enabled Website Scraper
"""

import requests
from typing import List, Optional, Dict, Any
import time
import random
import logging
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
import re

from . import get_proxy_manager

logger = logging.getLogger(__name__)

class ProxyScraper:
    """Website scraper with proxy rotation"""
    
    def __init__(self, rate_limit_delay: float = 1.0, use_proxies: bool = True):
        self.rate_limit_delay = rate_limit_delay
        self.use_proxies = use_proxies
        self.proxy_manager = get_proxy_manager() if use_proxies else None
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        })
    
    def get_with_proxy(self, url: str, max_retries: int = 3) -> Optional[requests.Response]:
        """Make request with proxy rotation and retries"""
        for attempt in range(max_retries):
            try:
                # Get proxy for this request
                proxies = None
                current_proxy = None
                
                if self.use_proxies and self.proxy_manager:
                    current_proxy = self.proxy_manager.get_proxy()
                    if current_proxy:
                        proxies = {
                            'http': current_proxy.url,
                            'https': current_proxy.url
                        }
                
                logger.info(f"Requesting {url} (attempt {attempt + 1}/{max_retries})"
                          f"{f' via proxy {current_proxy.id}' if current_proxy else ' without proxy'}")
                
                response = self.session.get(
                    url,
                    proxies=proxies,
                    timeout=30,
                    allow_redirects=True
                )
                
                # Mark proxy success/failure
                if current_proxy:
                    if response.status_code == 200:
                        current_proxy.mark_success()
                        self.proxy_manager.save_proxies()
                    else:
                        current_proxy.mark_failure()
                        self.proxy_manager.save_proxies()
                
                # Rate limiting
                time.sleep(self.rate_limit_delay * random.uniform(0.8, 1.2))
                
                return response
                
            except requests.exceptions.ProxyError as e:
                logger.warning(f"Proxy error on attempt {attempt + 1}: {e}")
                if current_proxy:
                    current_proxy.mark_failure()
                    self.proxy_manager.save_proxies()
                
                # Try without proxy on last attempt
                if attempt == max_retries - 1 and self.use_proxies:
                    logger.info("Last attempt failed, trying without proxy...")
                    self.use_proxies = False
                    return self.get_with_proxy(url, max_retries=1)
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request error on attempt {attempt + 1}: {e}")
                if current_proxy:
                    current_proxy.mark_failure()
                    self.proxy_manager.save_proxies()
                
                if attempt == max_retries - 1:
                    return None
            
            # Exponential backoff
            if attempt < max_retries - 1:
                sleep_time = 2 ** attempt + random.uniform(0, 1)
                logger.info(f"Retrying in {sleep_time:.1f} seconds...")
                time.sleep(sleep_time)
        
        return None
    
    def scrape_website(self, url: str) -> Dict[str, Any]:
        """Scrape website for contact information with proxy support"""
        result = {
            'url': url,
            'success': False,
            'phone_numbers': [],
            'email_addresses': [],
            'contact_pages': [],
            'social_links': [],
            'title': '',
            'description': '',
            'error': None
        }
        
        try:
            # Ensure URL has scheme
            if not url.startswith(('http://', 'https://')):
                url = 'https://' + url
            
            response = self.get_with_proxy(url)
            
            if not response or response.status_code != 200:
                result['error'] = f"Failed to fetch URL: {response.status_code if response else 'No response'}"
                return result
            
            soup = BeautifulSoup(response.content, 'html.parser')
            
            # Extract basic info
            result['title'] = soup.title.string if soup.title else ''
            
            meta_desc = soup.find('meta', attrs={'name': 'description'})
            result['description'] = meta_desc['content'] if meta_desc else ''
            
            # Extract phone numbers
            result['phone_numbers'] = self.extract_phone_numbers(soup, url)
            
            # Extract email addresses
            result['email_addresses'] = self.extract_email_addresses(soup)
            
            # Find contact pages
            result['contact_pages'] = self.find_contact_pages(soup, url)
            
            # Find social links
            result['social_links'] = self.find_social_links(soup, url)
            
            result['success'] = True
            
        except Exception as e:
            result['error'] = str(e)
            logger.error(f"Error scraping {url}: {e}")
        
        return result
    
    def extract_phone_numbers(self, soup: BeautifulSoup, base_url: str) -> List[Dict[str, str]]:
        """Extract and classify phone numbers"""
        phone_patterns = [
            r'\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}',  # US format
            r'\+\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}',  # International
            r'\d{3}[-.\s]?\d{3}[-.\s]?\d{4}',  # Simple format
            r'tel:[\d\+\(\)\s-]+',  # tel: links
        ]
        
        all_numbers = []
        text = soup.get_text()
        
        for pattern in phone_patterns:
            matches = re.finditer(pattern, text)
            for match in matches:
                phone = match.group().strip()
                
                # Clean up the phone number
                phone = re.sub(r'[^\d\+\(\)]', '', phone)
                
                # Classify the phone number
                phone_type = self.classify_phone_number(phone, soup, base_url)
                
                all_numbers.append({
                    'number': phone,
                    'type': phone_type,
                    'context': self.get_phone_context(match, text)
                })
        
        # Remove duplicates while preserving order
        seen = set()
        unique_numbers = []
        for num in all_numbers:
            if num['number'] not in seen:
                seen.add(num['number'])
                unique_numbers.append(num)
        
        return unique_numbers
    
    def classify_phone_number(self, phone: str, soup: BeautifulSoup, base_url: str) -> str:
        """Classify phone number type"""
        phone_lower = phone.lower()
        
        # Check for toll-free numbers
        toll_free_prefixes = ['800', '888', '877', '866', '855', '844', '833']
        if any(phone.startswith(prefix) for prefix in toll_free_prefixes):
            return 'toll_free'
        
        # Check context in page
        text = soup.get_text().lower()
        phone_context = text[max(0, text.find(phone_lower) - 100):text.find(phone_lower) + 100]
        
        # Decision maker indicators
        decision_keywords = [
            'loan', 'mortgage', 'reo', 'workout', 'special assets',
            'distressed', 'default', 'foreclosure', 'collection',
            'officer', 'manager', 'director', 'vp', 'vice president',
            'department', 'division', 'workout', 'special assets'
        ]
        
        for keyword in decision_keywords:
            if keyword in phone_context:
                return 'decision_maker'
        
        # Customer service indicators
        service_keywords = [
            'customer service', 'support', 'help', 'contact us',
            'call us', 'phone number', 'telephone', 'contact'
        ]
        
        for keyword in service_keywords:
            if keyword in phone_context:
                return 'customer_service'
        
        # Branch indicators
        branch_keywords = [
            'branch', 'location', 'office', 'atm', 'banking center',
            'financial center', 'store', 'retail'
        ]
        
        for keyword in branch_keywords:
            if keyword in phone_context:
                return 'branch'
        
        # Corporate indicators
        corporate_keywords = [
            'corporate', 'headquarters', 'main office', 'executive',
            'administration', 'head office'
        ]
        
        for keyword in corporate_keywords:
            if keyword in phone_context:
                return 'corporate'
        
        # Default to unknown
        return 'unknown'
    
    def get_phone_context(self, match: re.Match, text: str) -> str:
        """Get context around phone number"""
        start = max(0, match.start() - 50)
        end = min(len(text), match.end() + 50)
        context = text[start:end].strip()
        
        # Clean up context
        context = re.sub(r'\s+', ' ', context)
        return context
    
    def extract_email_addresses(self, soup: BeautifulSoup) -> List[str]:
        """Extract email addresses"""
        email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
        text = soup.get_text()
        
        emails = re.findall(email_pattern, text)
        
        # Also check mailto links
        mailto_links = soup.find_all('a', href=re.compile(r'mailto:'))
        for link in mailto_links:
            email = link['href'].replace('mailto:', '').split('?')[0]
            if email and email not in emails:
                emails.append(email)
        
        return list(set(emails))
    
    def find_contact_pages(self, soup: BeautifulSoup, base_url: str) -> List[str]:
        """Find contact page links"""
        contact_keywords = [
            'contact', 'contact-us', 'contactus', 'contact.html',
            'about', 'about-us', 'locations', 'branches',
            'customer-service', 'support', 'help'
        ]
        
        contact_links = []
        
        # Check all links
        for link in soup.find_all('a', href=True):
            href = link['href'].lower()
            text = link.get_text().lower()
            
            # Check if link contains contact keywords
            is_contact = any(keyword in href or keyword in text 
                           for keyword in contact_keywords)
            
            if is_contact:
                # Make absolute URL
                absolute_url = urljoin(base_url, link['href'])
                if absolute_url not in contact_links:
                    contact_links.append(absolute_url)
        
        return contact_links
    
    def find_social_links(self, soup: BeautifulSoup, base_url: str) -> List[Dict[str, str]]:
        """Find social media links"""
        social_patterns = {
            'linkedin': r'linkedin\.com',
            'facebook': r'facebook\.com',
            'twitter': r'twitter\.com|x\.com',
            'instagram': r'instagram\.com',
            'youtube': r'youtube\.com',
        }
        
        social_links = []
        
        for link in soup.find_all('a', href=True):
            href = link['href']
            
            for platform, pattern in social_patterns.items():
                if re.search(pattern, href, re.IGNORECASE):
                    absolute_url = urljoin(base_url, href)
                    social_links.append({
                        'platform': platform,
                        'url': absolute_url,
                        'text': link.get_text().strip()
                    })
                    break
        
        return social_links
    
    def scrape_contact_page(self, url: str) -> Dict[str, Any]:
        """Specialized scraping for contact pages"""
        result = self.scrape_website(url)
        
        if result['success']:
            # Enhance contact page results
            result['is_contact_page'] = True
            
            # Look for specific contact information
            soup = BeautifulSoup(result.get('_html', ''), 'html.parser') if '_html' in result else None
            
            if soup:
                # Look for contact forms
                forms = soup.find_all('form')
                result['has_contact_form'] = len(forms) > 0
                
                # Look for address information
                address_patterns = [
                    r'\d+\s+[\w\s]+,\s*[\w\s]+,\s*[A-Z]{2}\s+\d{5}',
                    r'P\.?O\.?\s+Box\s+\d+',
                    r'PO Box \d+'
                ]
                
                addresses = []
                text = soup.get_text()
                for pattern in address_patterns:
                    addresses.extend(re.findall(pattern, text))
                
                result['addresses'] = addresses
        
        return result

# Example usage
if __name__ == "__main__":
    # Initialize scraper with proxies
    scraper = ProxyScraper(use_proxies=True)
    
    # Test scrape
    result = scraper.scrape_website("https://www.example.com")
    print(f"Success: {result['success']}")
    print(f"Phone numbers: {len(result['phone_numbers'])}")
    
    for phone in result['phone_numbers']:
        print(f"  {phone['number']} - {phone['type']}")