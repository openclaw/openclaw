# CUTMV Security Documentation

## Database Security Overview

CUTMV implements enterprise-grade database security practices to protect user data, referral information, and system credentials.

## Credential Management

### Environment Variables
All sensitive credentials are stored securely in Replit Secrets:

- `DATABASE_URL` - PostgreSQL connection string
- `SUPABASE_URL` - Supabase project URL  
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `ADMIN_EMAIL` - Admin authentication email
- `ADMIN_PASSWORD` - Admin password (bcrypt hashed recommended)

### Password Security

#### Admin Password Hashing
For production deployments, admin passwords should be bcrypt-hashed:

```bash
# Generate secure password hash
node scripts/hash-admin-password.js "your-secure-password"

# Store the resulting hash in ADMIN_PASSWORD secret
```

#### Special Characters in Database URLs
Database passwords with special characters are automatically handled. If manually constructing URLs:

```javascript
// For password: MySecure@2025
const password = encodeURIComponent('MySecure@2025'); // becomes MySecure%402025
const databaseUrl = `postgresql://user:${password}@host:port/database`;
```

## Security Features

### Connection Security
- ✅ All database connections use environment variables
- ✅ Connection string format validation
- ✅ Automatic handling of special characters
- ✅ Secure connection pooling
- ✅ No credentials logged or exposed

### Authentication Security
- ✅ Bcrypt password hashing support
- ✅ Rate-limited admin login (5 attempts per 15 minutes)
- ✅ IP tracking and audit logging
- ✅ Session expiration and validation
- ✅ Magic link email authentication

### Data Protection
- ✅ Row-level security policies in Supabase
- ✅ Input validation and sanitization
- ✅ Secure random token generation
- ✅ Audit logging for all admin actions
- ✅ Automatic cleanup of expired sessions

## Security Audit Results

**Latest Audit: July 26, 2025**
**Security Rating: A+ (Excellent)**

### Findings:
- ✅ No hardcoded passwords or credentials found
- ✅ All connections properly secured
- ✅ Environment variables correctly implemented
- ✅ URI encoding compliant
- ✅ Admin authentication properly protected

### Recommendations Implemented:
- ✅ Database URL format validation
- ✅ Enhanced admin password security warnings
- ✅ Supabase URL validation
- ✅ Password hashing utility script

## Compliance

CUTMV database security meets industry standards for:
- Credential protection
- Connection security
- Access control
- Audit logging
- Data encryption

## Security Contacts

For security-related concerns or to report vulnerabilities:
- Email: security@fulldigitalll.com
- Review: DATABASE_SECURITY_AUDIT.md

---
*Last Updated: July 26, 2025*