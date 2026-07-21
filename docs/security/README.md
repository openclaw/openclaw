# Mythos Security Hardening Guide

Comprehensive security guide for production Mythos deployments.

## Security Architecture Overview

Mythos implements defense-in-depth security:

```
┌─────────────────────────────────────────┐
│           Network Layer                 │
│  • TLS/SSL Encryption                   │
│  • Network Policies                     │
│  • Firewall Rules                       │
├─────────────────────────────────────────┤
│         Application Layer               │
│  • Authentication (JWT/Tokens)          │
│  • Authorization (RBAC)                 │
│  • Input Validation                     │
├─────────────────────────────────────────┤
│            Data Layer                   │
│  • Encryption at Rest                   │
│  • Secret Management                    │
│  • Data Classification                  │
├─────────────────────────────────────────┤
│          Infrastructure Layer           │
│  • Container Isolation                  │
│  • Resource Limits                      │
│  • Audit Logging                        │
└─────────────────────────────────────────┘
```

---

## Authentication & Authorization

### Gateway Token Authentication

**Generate Strong Token:**
```bash
openssl rand -hex 32
# Example: a1b2c3d4e5f6...
```

**Configure Token:**
```bash
# Environment variable
export OPENCLAW_GATEWAY_TOKEN="your-secure-token"

# Or in openclaw.json
{
  "gateway": {
    "auth": {
      "token": "your-secure-token"
    }
  }
}
```

**Token Rotation:**
```bash
# Automated rotation script
./automation/mythos-automation.sh rotate-token --interval 30d
```

### Role-Based Access Control (RBAC)

**Define Roles:**
```json
{
  "roles": {
    "admin": {
      "permissions": ["*"]
    },
    "operator": {
      "permissions": ["read", "write", "execute"]
    },
    "viewer": {
      "permissions": ["read"]
    },
    "agent": {
      "permissions": ["read", "execute"],
      "restrictions": ["no-admin", "sandbox-only"]
    }
  }
}
```

**Assign Roles:**
```typescript
await rbac.assignRole('user_123', 'operator');
const permissions = await rbac.getPermissions('user_123');
```

---

## Network Security

### TLS/SSL Configuration

**Generate Certificates:**
```bash
# Self-signed (development)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Production (Let's Encrypt)
certbot certonly --standalone -d mythos.example.com
```

**Configure TLS:**
```json
{
  "gateway": {
    "tls": {
      "enabled": true,
      "cert": "/etc/ssl/certs/mythos.crt",
      "key": "/etc/ssl/private/mythos.key",
      "minVersion": "TLSv1.3"
    }
  }
}
```

### Network Policies (Kubernetes)

**Restrict Ingress:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mythos-ingress-policy
  namespace: mythos
spec:
  podSelector:
    matchLabels:
      app: mythos-gateway
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - protocol: TCP
      port: 18789
```

**Restrict Egress:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mythos-egress-policy
  namespace: mythos
spec:
  podSelector:
    matchLabels:
      app: mythos-gateway
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443  # HTTPS to external APIs
    - protocol: TCP
      port: 5432 # PostgreSQL
    - protocol: TCP
      port: 6379 # Redis
```

### Firewall Rules

**UFW (Ubuntu):**
```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow Mythos gateway
sudo ufw allow 18789/tcp

# Enable firewall
sudo ufw enable
```

**iptables:**
```bash
# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow Mythos gateway
iptables -A INPUT -p tcp --dport 18789 -j ACCEPT

# Drop all other
iptables -A INPUT -j DROP
```

---

## Data Protection

### Encryption at Rest

**PostgreSQL:**
```sql
-- Enable encryption
CREATE EXTENSION pgcrypto;

-- Encrypt sensitive columns
UPDATE users SET 
  email = pgp_sym_encrypt(email, 'encryption-key'),
  api_key = pgp_sym_encrypt(api_key, 'encryption-key');
```

**File System:**
```bash
# Enable LUKS encryption
sudo cryptsetup luksFormat /dev/sda1
sudo cryptsetup luksOpen /dev/sda1 encrypted
sudo mkfs.ext4 /dev/mapper/encrypted
sudo mount /dev/mapper/encrypted /mnt/encrypted
```

### Secret Management

**Kubernetes Secrets:**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mythos-secrets
  namespace: mythos
type: Opaque
data:
  gateway-token: $(echo -n "token" | base64)
  anthropic-key: $(echo -n "key" | base64)
```

**HashiCorp Vault:**
```bash
# Store secrets
vault kv put secret/mythos \
  gateway-token="token" \
  anthropic-key="key"

# Retrieve in application
vault kv get -field=gateway-token secret/mythos
```

**Sealed Secrets:**
```bash
# Install sealed secrets controller
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.24.5/controller.yaml

# Encrypt secret
kubeseal < secret.yaml > sealed-secret.yaml

# Apply encrypted secret
kubectl apply -f sealed-secret.yaml
```

### Data Classification

**Classify Data:**
```typescript
enum DataClassification {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted'
}

const document = {
  content: 'User data',
  classification: DataClassification.CONFIDENTIAL,
  encryption: true,
  retention: '365d'
};
```

---

## Container Security

### Security Context

**Pod Security:**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: mythos-gateway
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
  - name: gateway
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

### Resource Limits

**Prevent Resource Exhaustion:**
```yaml
resources:
  requests:
    memory: "2Gi"
    cpu: "1000m"
  limits:
    memory: "4Gi"
    cpu: "2000m"
```

### Image Security

**Scan Images:**
```bash
# Install Trivy
brew install trivy  # macOS
# or
apt-get install trivy  # Linux

# Scan image
trivy image openclaw/mythos:latest

# Check for vulnerabilities
trivy image --severity HIGH,CRITICAL openclaw/mythos:latest
```

**Use Minimal Base Images:**
```dockerfile
# Bad: Large image
FROM node:22

# Good: Minimal image
FROM node:22-alpine
```

---

## Audit Logging

### Enable Audit Logs

**Application Logs:**
```json
{
  "logging": {
    "level": "info",
    "audit": {
      "enabled": true,
      "events": [
        "authentication",
        "authorization",
        "data_access",
        "configuration_change",
        "agent_action"
      ]
    }
  }
}
```

**Kubernetes Audit:**
```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata
  resources:
  - group: ""
    resources: ["pods", "services"]
- level: Request
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]
```

### Log Analysis

**SIEM Integration:**
```bash
# Forward logs to SIEM
kubectl logs -f deployment/mythos-gateway | \
  fluent-bit -i stdin -o splunk -p host=splunk.example.com
```

**Alerting:**
```yaml
# Prometheus alert
groups:
- name: security
  rules:
  - alert: FailedAuthentication
    expr: rate(mythos_auth_failures_total[5m]) > 10
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "High authentication failure rate"
```

---

## API Security

### Rate Limiting

**Configure Rate Limits:**
```json
{
  "gateway": {
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "maxRequests": 100,
      "byIp": true,
      "byUser": true
    }
  }
}
```

### Input Validation

**Validate Requests:**
```typescript
import { z } from 'zod';

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  top_k: z.number().min(1).max(100),
  filters: z.record(z.unknown()).optional()
});

app.post('/api/v1/search', (req, res) => {
  const result = searchSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  // Process valid request
});
```

### CORS Configuration

**Restrict Origins:**
```json
{
  "gateway": {
    "cors": {
      "enabled": true,
      "origins": ["https://mythos.example.com"],
      "methods": ["GET", "POST"],
      "credentials": true
    }
  }
}
```

---

## Dependency Security

### Vulnerability Scanning

**Node.js:**
```bash
# Audit dependencies
npm audit

# Fix vulnerabilities
npm audit fix

# Or use pnpm
pnpm audit
```

**Rust:**
```bash
# Audit dependencies
cargo audit

# Check for outdated
cargo outdated
```

### Software Bill of Materials (SBOM)

**Generate SBOM:**
```bash
# Install Syft
brew install syft  # macOS

# Generate SBOM
syft openclaw/mythos:latest -o spdx-json > sbom.json
```

---

## Compliance

### SOC 2 Controls

**Access Control:**
- ✅ Unique user IDs
- ✅ Role-based access
- ✅ Multi-factor authentication
- ✅ Audit logging

**Data Protection:**
- ✅ Encryption at rest
- ✅ Encryption in transit
- ✅ Data classification
- ✅ Backup and recovery

**Monitoring:**
- ✅ Intrusion detection
- ✅ Anomaly detection
- ✅ Security alerts
- ✅ Incident response

### GDPR Compliance

**Data Subject Rights:**
```typescript
// Right to access
app.get('/api/v1/users/:id/data', async (req, res) => {
  const data = await getUserData(req.params.id);
  res.json(data);
});

// Right to erasure
app.delete('/api/v1/users/:id', async (req, res) => {
  await deleteUser(req.params.id);
  res.json({ success: true });
});

// Right to portability
app.get('/api/v1/users/:id/export', async (req, res) => {
  const data = await exportUserData(req.params.id);
  res.json(data);
});
```

**Data Processing Agreement:**
```typescript
const dataProcessingAgreement = {
  purpose: 'AI agent coordination',
  retention: '365 days',
  encryption: true,
  anonymization: true,
  crossBorderTransfer: false
};
```

---

## Security Checklist

### Pre-Production

- [ ] TLS/SSL enabled
- [ ] Strong authentication tokens
- [ ] RBAC configured
- [ ] Network policies applied
- [ ] Secrets encrypted
- [ ] Audit logging enabled
- [ ] Rate limiting configured
- [ ] Input validation implemented
- [ ] Dependencies audited
- [ ] Container security hardened
- [ ] Resource limits set
- [ ] Backup configured
- [ ] Monitoring deployed
- [ ] Alerts configured
- [ ] Incident response plan documented

### Ongoing

- [ ] Weekly dependency audits
- [ ] Monthly security scans
- [ ] Quarterly penetration tests
- [ ] Annual compliance review
- [ ] Regular token rotation
- [ ] Log review and analysis
- [ ] Security training for team
- [ ] Incident response drills

---

## Incident Response

### Security Incident Procedure

**1. Detection:**
```bash
# Monitor for suspicious activity
tail -f /var/log/mythos/audit.log | grep -E "failed|denied|error"
```

**2. Containment:**
```bash
# Isolate affected component
kubectl scale deployment/mythos-gateway --replicas=0 -n mythos

# Block malicious IP
iptables -A INPUT -s 192.168.1.100 -j DROP
```

**3. Investigation:**
```bash
# Analyze logs
grep -E "ERROR|FATAL|SECURITY" /var/log/mythos/*.log

# Check for data exfiltration
netstat -an | grep ESTABLISHED
```

**4. Eradication:**
```bash
# Remove malicious code
git checkout -- .
rm -rf node_modules
pnpm install
```

**5. Recovery:**
```bash
# Restore from backup
./automation/mythos-automation.sh restore /backup/clean-backup.tar.gz

# Verify integrity
./automation/mythos-automation.sh health-check
```

**6. Lessons Learned:**
- Document incident
- Update security controls
- Train team
- Update incident response plan

---

## Security Tools

### Recommended Tools

**Scanning:**
- **Trivy:** Container vulnerability scanner
- **Snyk:** Dependency vulnerability scanner
- **SonarQube:** Code quality and security

**Monitoring:**
- **Prometheus:** Metrics collection
- **Grafana:** Visualization
- **ELK Stack:** Log analysis

**Protection:**
- **Fail2ban:** Intrusion prevention
- **ModSecurity:** Web application firewall
- **ClamAV:** Antivirus

**Testing:**
- **OWASP ZAP:** Web application security testing
- **Burp Suite:** Penetration testing
- **Metasploit:** Exploitation framework

---

## Support

### Security Reporting

**Report Vulnerabilities:**
- **Email:** security@openclaw.ai
- **GitHub:** https://github.com/openclaw/openclaw/security/advisories

**Security Advisories:**
- Subscribe to security mailing list
- Monitor GitHub releases
- Follow security blog

### Commercial Support

For enterprise security support:
- **Email:** support@openclaw.ai
- **Website:** https://openclaw.ai/security
- **Phone:** +1-555-MYTHOS

---

## License

MIT License - See LICENSE for details.
