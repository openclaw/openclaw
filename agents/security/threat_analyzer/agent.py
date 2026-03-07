"""
Security Threat Analyzer Agent

Analyzes security threats, malware, and provides threat intelligence.
Demonstrates a security domain agent with read-only risk level.
"""

import hashlib
import re
from typing import Any, Dict, List, Optional
from datetime import datetime

from engine.agents.base import BaseAgent


class ThreatAnalyzerAgent(BaseAgent):
    """
    Security threat analysis agent.
    
    Domain: security
    Risk Level: read_only (analysis only, no system modifications)
    """
    
    def __init__(self) -> None:
        super().__init__()
        self.demo_mode = True
        self.virustotal_api_key = None
    
    async def initialize(self, config: Dict[str, Any]) -> None:
        """Initialize with configuration"""
        self.demo_mode = config.get("demo_mode", True)
        self.virustotal_api_key = config.get("virustotal_api_key")
        self.mark_initialized()
    
    async def execute(self, task: str, context: Optional[Dict[str, Any]] = None) -> Any:
        """
        Execute a security analysis task.
        
        Supports:
        - "analyze hash [hash]"
        - "analyze url [url]"
        - "threat intel [topic]"
        - "security recommendations for [system]"
        """
        task_lower = task.lower()
        
        try:
            if "analyze hash" in task_lower or "check hash" in task_lower:
                hash_value = self._extract_hash(task)
                result = self._analyze_hash(hash_value)
            elif "analyze url" in task_lower or "check url" in task_lower:
                url = self._extract_url(task)
                result = self._analyze_url(url)
            elif "threat intel" in task_lower:
                topic = task.split("threat intel")[-1].strip()
                result = self._get_threat_intel(topic)
            elif "security recommendation" in task_lower or "security advice" in task_lower:
                system = task.split("for")[-1].strip() if "for" in task else "general"
                result = self._get_security_recommendations(system)
            else:
                result = self._general_security_response(task)
            
            self.record_execution(success=True)
            return result
            
        except Exception as e:
            self.record_execution(success=False)
            raise
    
    def get_capabilities(self) -> List[str]:
        """Get agent capabilities"""
        return [
            "Analyze file hashes for malware indicators",
            "Provide threat intelligence summaries",
            "Identify security vulnerabilities",
            "Generate security recommendations",
            "Analyze suspicious URLs and domains",
            "Assess threat severity levels",
        ]
    
    async def cleanup(self) -> None:
        """Cleanup resources"""
        pass
    
    # ========================================================================
    # Analysis Methods
    # ========================================================================
    
    def _extract_hash(self, task: str) -> str:
        """Extract hash from task"""
        # Look for MD5, SHA1, or SHA256 patterns
        patterns = [
            r'[a-fA-F0-9]{32}',  # MD5
            r'[a-fA-F0-9]{40}',  # SHA1
            r'[a-fA-F0-9]{64}',  # SHA256
        ]
        
        for pattern in patterns:
            match = re.search(pattern, task)
            if match:
                return match.group(0)
        
        raise ValueError("No valid hash found in task")
    
    def _extract_url(self, task: str) -> str:
        """Extract URL from task"""
        url_pattern = r'https?://[^\s]+'
        match = re.search(url_pattern, task)
        if match:
            return match.group(0)
        
        # Try to extract domain
        words = task.split()
        for word in words:
            if '.' in word and not word.startswith('.'):
                return word
        
        raise ValueError("No valid URL found in task")
    
    def _analyze_hash(self, hash_value: str) -> Dict[str, Any]:
        """Analyze a file hash"""
        # In demo mode, provide simulated analysis
        hash_type = self._detect_hash_type(hash_value)
        
        # Simulate threat detection
        is_malicious = hash(hash_value) % 3 == 0  # Pseudo-random for demo
        
        return {
            "type": "hash_analysis",
            "hash": hash_value,
            "hash_type": hash_type,
            "analysis_time": datetime.now().isoformat(),
            "demo_mode": self.demo_mode,
            "verdict": {
                "malicious": is_malicious,
                "severity": "high" if is_malicious else "clean",
                "confidence": 0.85 if is_malicious else 0.95,
            },
            "detections": {
                "total_engines": 70 if not self.demo_mode else "N/A (demo mode)",
                "malicious_detections": 45 if is_malicious else 0,
                "suspicious_detections": 5 if is_malicious else 0,
            },
            "threat_names": [
                "Trojan.Generic.KD.12345",
                "Malware.AI.Detection",
                "Suspicious.Behavior.Pattern"
            ] if is_malicious else [],
            "recommendations": [
                "Quarantine the file immediately" if is_malicious else "File appears clean",
                "Run additional behavioral analysis" if is_malicious else "Monitor for false positives",
                "Check file origin and distribution" if is_malicious else "Safe to proceed",
            ],
            "note": "Demo mode - using simulated data. Configure API keys for real analysis." if self.demo_mode else None,
        }
    
    def _analyze_url(self, url: str) -> Dict[str, Any]:
        """Analyze a URL"""
        # Simulate URL analysis
        is_malicious = len(url) % 2 == 0  # Pseudo-random for demo
        
        return {
            "type": "url_analysis",
            "url": url,
            "analysis_time": datetime.now().isoformat(),
            "demo_mode": self.demo_mode,
            "verdict": {
                "malicious": is_malicious,
                "category": "phishing" if is_malicious else "legitimate",
                "risk_score": 8.5 if is_malicious else 1.2,
            },
            "indicators": {
                "suspicious_tld": is_malicious,
                "typosquatting": is_malicious,
                "newly_registered": is_malicious,
                "ssl_certificate": not is_malicious,
            },
            "recommendations": [
                "Block this URL in firewall" if is_malicious else "URL appears safe",
                "Alert users about phishing attempt" if is_malicious else "Continue normal operations",
                "Report to threat intelligence feeds" if is_malicious else "Add to whitelist if needed",
            ],
            "note": "Demo mode - using simulated data. Configure API keys for real analysis." if self.demo_mode else None,
        }
    
    def _get_threat_intel(self, topic: str) -> Dict[str, Any]:
        """Get threat intelligence on a topic"""
        return {
            "type": "threat_intelligence",
            "topic": topic or "general threats",
            "timestamp": datetime.now().isoformat(),
            "summary": f"Current threat landscape for {topic or 'general security'}",
            "active_threats": [
                {
                    "name": "Ransomware Campaign 2026-Q1",
                    "severity": "critical",
                    "description": "Widespread ransomware targeting enterprise networks",
                    "indicators": ["Unusual network encryption", "Ransom notes", "Lateral movement"],
                },
                {
                    "name": "Phishing Wave - Tax Season",
                    "severity": "high",
                    "description": "Tax-themed phishing emails with malicious attachments",
                    "indicators": ["Fake tax documents", "Urgent payment requests", "Suspicious links"],
                },
                {
                    "name": "Supply Chain Compromise",
                    "severity": "medium",
                    "description": "Compromised software update mechanisms",
                    "indicators": ["Unexpected updates", "Certificate anomalies", "Code signing issues"],
                },
            ],
            "recommendations": [
                "Implement multi-factor authentication across all systems",
                "Conduct security awareness training for phishing",
                "Review and update incident response procedures",
                "Monitor for unusual network activity",
                "Keep all systems patched and updated",
            ],
            "trending_cves": [
                "CVE-2026-0001: Critical RCE in popular framework",
                "CVE-2026-0002: Authentication bypass in enterprise software",
                "CVE-2026-0003: Privilege escalation in OS kernel",
            ],
        }
    
    def _get_security_recommendations(self, system: str) -> Dict[str, Any]:
        """Get security recommendations"""
        return {
            "type": "security_recommendations",
            "system": system,
            "timestamp": datetime.now().isoformat(),
            "recommendations": [
                {
                    "category": "Access Control",
                    "priority": "critical",
                    "items": [
                        "Implement principle of least privilege",
                        "Enable multi-factor authentication",
                        "Regular access reviews and audits",
                        "Strong password policies",
                    ]
                },
                {
                    "category": "Network Security",
                    "priority": "high",
                    "items": [
                        "Deploy next-generation firewalls",
                        "Implement network segmentation",
                        "Enable intrusion detection/prevention",
                        "Monitor network traffic anomalies",
                    ]
                },
                {
                    "category": "Data Protection",
                    "priority": "high",
                    "items": [
                        "Encrypt data at rest and in transit",
                        "Implement data loss prevention",
                        "Regular backup and recovery testing",
                        "Data classification and handling policies",
                    ]
                },
                {
                    "category": "Monitoring & Response",
                    "priority": "medium",
                    "items": [
                        "Deploy SIEM solution",
                        "Establish 24/7 security monitoring",
                        "Create incident response playbooks",
                        "Regular security drills and exercises",
                    ]
                },
            ],
            "compliance_frameworks": [
                "ISO 27001",
                "NIST Cybersecurity Framework",
                "CIS Controls",
                "GDPR (if applicable)",
            ],
        }
    
    def _general_security_response(self, task: str) -> Dict[str, Any]:
        """General security response"""
        return {
            "type": "general",
            "task": task,
            "response": "I can help with security analysis! Try asking me to:\n"
                       "- Analyze hash [hash value]\n"
                       "- Analyze url [url]\n"
                       "- Threat intel [topic]\n"
                       "- Security recommendations for [system]",
            "capabilities": self.get_capabilities(),
            "demo_mode": self.demo_mode,
        }
    
    def _detect_hash_type(self, hash_value: str) -> str:
        """Detect hash type based on length"""
        length = len(hash_value)
        if length == 32:
            return "MD5"
        elif length == 40:
            return "SHA1"
        elif length == 64:
            return "SHA256"
        else:
            return "Unknown"


# Agent instance (will be loaded by the engine)
agent = ThreatAnalyzerAgent()
