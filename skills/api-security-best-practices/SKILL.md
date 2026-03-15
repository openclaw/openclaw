---
name: api-security-best-practices
description: "Implement secure API design patterns including authentication, authorization, input validation, rate limiting, and protection against common API vulnerabilities"
risk: unknown
source: community
date_added: "2026-02-27"
---

# API Security Best Practices

## Overview

Guide developers in building secure APIs by implementing authentication, authorization, input validation, rate limiting, and protection against common vulnerabilities. This skill covers security patterns for REST, GraphQL, and WebSocket APIs.

## When to Use This Skill

- Use when designing new API endpoints
- Use when securing existing APIs
- Use when implementing authentication and authorization
- Use when protecting against API attacks (injection, DDoS, etc.)
- Use when conducting API security reviews
- Use when preparing for security audits
- Use when implementing rate limiting and throttling
- Use when handling sensitive data in APIs

## How It Works

### Step 1: Authentication & Authorization

I'll help you implement secure authentication:

- Choose authentication method (JWT, OAuth 2.0, API keys)
- Implement token-based authentication
- Set up role-based access control (RBAC)
- Secure session management
- Implement multi-factor authentication (MFA)

### Step 2: Input Validation & Sanitization

Protect against injection attacks:

- Validate all input data
- Sanitize user inputs
- Use parameterized queries
- Implement request schema validation
- Prevent SQL injection, XSS, and command injection

### Step 3: Rate Limiting & Throttling

Prevent abuse and DDoS attacks:

- Implement rate limiting per user/IP
- Set up API throttling
- Configure request quotas
- Handle rate limit errors gracefully
- Monitor for suspicious activity

### Step 4: Data Protection

Secure sensitive data:

- Encrypt data in transit (HTTPS/TLS)
- Encrypt sensitive data at rest
- Implement proper error handling (no data leaks)
- Sanitize error messages
- Use secure headers

### Step 5: API Security Testing

Verify security implementation:

- Test authentication and authorization
- Perform penetration testing
- Check for common vulnerabilities (OWASP API Top 10)
- Validate input handling
- Test rate limiting

## Examples

### Example 1: Implementing JWT Authentication

```markdown
## Secure JWT Authentication Implementation

### Authentication Flow

1. User logs in with credentials
2. Server validates credentials
3. Server generates JWT token
4. Client stores token securely
5. Client sends token with each request
6. Server validates token

### Implementation

#### 1. Generate Secure JWT Tokens

\`\`\`javascript
// auth.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
try {
const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Find user
    const user = await db.user.findUnique({
      where: { email }
    });

    if (!user) {
      // Don't reveal if user exists
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Verify password
    const validPassword = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '1h',
        issuer: 'your-app',
        audience: 'your-app-users'
      }
    );

    // Generate refresh token
    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    // Store refresh token in database
    await db.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });

    res.json({
      token,
      refreshToken,
      expiresIn: 3600
    });

} catch (error) {
console.error('Login error:', error);
res.status(500).json({
error: 'An error occurred during login'
});
}
});
\`\`\`

#### 2. Verify JWT Tokens (Middleware)

\`\`\`javascript
// middleware/auth.js
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
// Get token from header
const authHeader = req.headers['authorization'];
const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

if (!token) {
return res.status(401).json({
error: 'Access token required'
});
}

// Verify token
jwt.verify(
token,
process.env.JWT_SECRET,
{
issuer: 'your-app',
audience: 'your-app-users'
},
(err, user) => {
if (err) {
if (err.name === 'TokenExpiredError') {
return res.status(401).json({
error: 'Token expired'
});
}
return res.status(403).json({
error: 'Invalid token'
});
}

      // Attach user to request
      req.user = user;
      next();
    }

);
}

module.exports = { authenticateToken };
\`\`\`

#### 3. Protect Routes

\`\`\`javascript
const { authenticateToken } = require('./middleware/auth');

// Protected route
app.get('/api/user/profile', authenticateToken, async (req, res) => {
try {
const user = await db.user.findUnique({
where: { id: req.user.userId },
select: {
id: true,
email: true,
name: true,
// Don't return passwordHash
}
});

    res.json(user);

} catch (error) {
res.status(500).json({ error: 'Server error' });
}
});
\`\`\`

#### 4. Implement Token Refresh

\`\`\`javascript
app.post('/api/auth/refresh', async (req, res) => {
const { refreshToken } = req.body;

if (!refreshToken) {
return res.status(401).json({
error: 'Refresh token required'
});
}

try {
// Verify refresh token
const decoded = jwt.verify(
refreshToken,
process.env.JWT_REFRESH_SECRET
);

    // Check if refresh token exists in database
    const storedToken = await db.refreshToken.findFirst({
      where: {
        token: refreshToken,
        userId: decoded.userId,
        expiresAt: { gt: new Date() }
      }
    });

    if (!storedToken) {
      return res.status(403).json({
        error: 'Invalid refresh token'
      });
    }

    // Generate new access token
    const user = await db.user.findUnique({
      where: { id: decoded.userId }
    });

    const newToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token: newToken,
      expiresIn: 3600
    });

} catch (error) {
res.status(403).json({
error: 'Invalid refresh token'
});
}
});
\`\`\`

### Security Best Practices

- ✅ Use strong JWT secrets (256-bit minimum)
- ✅ Set short expiration times (1 hour for access tokens)
- ✅ Implement refresh tokens for long-lived sessions
- ✅ Store refresh tokens in database (can be revoked)
- ✅ Use HTTPS only
- ✅ Don't store sensitive data in JWT payload
- ✅ Validate token issuer and audience
- ✅ Implement token blacklisting for logout
```

### Example 2: Input Validation and SQL Injection Prevention

```markdown
## Preventing SQL Injection and Input Validation

### The Problem

**❌ Vulnerable Code:**
\`\`\`javascript
// NEVER DO THIS - SQL Injection vulnerability
app.get('/api/users/:id', async (req, res) => {
const userId = req.params.id;

// Dangerous: User input directly in query
const query = \`SELECT \* FROM users WHERE id = '\${userId}'\`;
const user = await db.query(query);

res.json(user);
});

// Attack example:
// GET /api/users/1' OR '1'='1
// Returns all users!
\`\`\`

### The Solution

#### 1. Use Parameterized Queries

\`\`\`javascript
// ✅ Safe: Parameterized query
app.get('/api/users/:id', async (req, res) => {
const userId = req.params.id;

// Validate input first
if (!userId || !/^\d+$/.test(userId)) {
return res.status(400).json({
error: 'Invalid user ID'
});
}

// Use parameterized query
const user = await db.query(
'SELECT id, email, name FROM users WHERE id = $1',
[userId]
);

if (!user) {
return res.status(404).json({
error: 'User not found'
});
}

res.json(user);
});
\`\`\`

#### 2. Use ORM with Proper Escaping

\`\`\`javascript
// ✅ Safe: Using Prisma ORM
app.get('/api/users/:id', async (req, res) => {
const userId = parseInt(req.params.id);

if (isNaN(userId)) {
return res.status(400).json({
error: 'Invalid user ID'
});
}

const user = await prisma.user.findUnique({
where: { id: userId },
select: {
id: true,
email: true,
name: true,
// Don't select sensitive fields
}
});

if (!user) {
return res.status(404).json({
error: 'User not found'
});
}

res.json(user);
});
\`\`\`

#### 3. Implement Request Validation with Zod

\`\`\`javascript
const { z } = require('zod');

// Define validation schema
const createUserSchema = z.object({
email: z.string().email('Invalid email format'),
password: z.string()
.min(8, 'Password must be at least 8 characters')
.regex(/[A-Z]/, 'Password must contain uppercase letter')
.regex(/[a-z]/, 'Password must contain lowercase letter')
.regex(/[0-9]/, 'Password must contain number'),
name: z.string()
.min(2, 'Name must be at least 2 characters')
.max(100, 'Name too long'),
age: z.number()
.int('Age must be an integer')
.min(18, 'Must be 18 or older')
.max(120, 'Invalid age')
.optional()
});

// Validation middleware
function validateRequest(schema) {
return (req, res, next) => {
try {
schema.parse(req.body);
next();
} catch (error) {
res.status(400).json({
error: 'Validation failed',
details: error.errors
});
}
};
}

// Use validation
app.post('/api/users',
validateRequest(createUserSchema),
async (req, res) => {
// Input is validated at this point
const { email, password, name, age } = req.body;

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        age
      }
    });

    // Don't return password hash
    const { passwordHash: _, ...userWithoutPassword } = user;
    res.status(201).json(userWithoutPassword);

}
);
\`\`\`

#### 4. Sanitize Output to Prevent XSS

\`\`\`javascript
const DOMPurify = require('isomorphic-dompurify');

app.post('/api/comments', authenticateToken, async (req, res) => {
const { content } = req.body;

// Validate
if (!content || content.length > 1000) {
return res.status(400).json({
error: 'Invalid comment content'
});
}

// Sanitize HTML to prevent XSS
const sanitizedContent = DOMPurify.sanitize(content, {
ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
ALLOWED_ATTR: ['href']
});

const comment = await prisma.comment.create({
data: {
content: sanitizedContent,
userId: req.user.userId
}
});

res.status(201).json(comment);
});
\`\`\`

### Validation Checklist

- [ ] Validate all user inputs
- [ ] Use parameterized queries or ORM
- [ ] Validate data types (string, number, email, etc.)
- [ ] Validate data ranges (min/max length, value ranges)
- [ ] Sanitize HTML content
- [ ] Escape special characters
- [ ] Validate file uploads (type, size, content)
- [ ] Use allowlists, not blocklists
```

### Example 3: Rate Limiting and DDoS Protection

```markdown
## Implementing Rate Limiting

### Why Rate Limiting?

- Prevent brute force attacks
- Protect against DDoS
- Prevent API abuse
- Ensure fair usage
- Reduce server costs

### Implementation with Express Rate Limit

\`\`\`javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');

// Create Redis client
const redis = new Redis({
host: process.env.REDIS_HOST,
port: process.env.REDIS_PORT
});

// General API rate limit
const apiLimiter = rateLimit({
store: new RedisStore({
client: redis,
prefix: 'rl:api:'
}),
windowMs: 15 _ 60 _ 1000, // 15 minutes
max: 100, // 100 requests per window
message: {
error: 'Too many requests, please try again later',
retryAfter: 900 // seconds
},
standardHeaders: true, // Return rate limit info in headers
legacyHeaders: false,
// Custom key generator (by user ID or IP)
keyGenerator: (req) => {
return req.user?.userId || req.ip;
}
});

// Strict rate limit for authentication endpoints
const authLimiter = rateLimit({
store: new RedisStore({
client: redis,
prefix: 'rl:auth:'
}),
windowMs: 15 _ 60 _ 1000, // 15 minutes
max: 5, // Only 5 login attempts per 15 minutes
skipSuccessfulRequests: true, // Don't count successful logins
message: {
error: 'Too many login attempts, please try again later',
retryAfter: 900
}
});

// Apply rate limiters
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Custom rate limiter for expensive operations
const expensiveLimiter = rateLimit({
windowMs: 60 _ 60 _ 1000, // 1 hour
max: 10, // 10 requests per hour
message: {
error: 'Rate limit exceeded for this operation'
}
});

app.post('/api/reports/generate',
authenticateToken,
expensiveLimiter,
async (req, res) => {
// Expensive operation
}
);
\`\`\`

### Advanced: Per-User Rate Limiting

\`\`\`javascript
// Different limits based on user tier
function createTieredRateLimiter() {
const limits = {
free: { windowMs: 60 _ 60 _ 1000, max: 100 },
pro: { windowMs: 60 _ 60 _ 1000, max: 1000 },
enterprise: { windowMs: 60 _ 60 _ 1000, max: 10000 }
};

return async (req, res, next) => {
const user = req.user;
const tier = user?.tier || 'free';
const limit = limits[tier];

    const key = \`rl:user:\${user.userId}\`;
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, limit.windowMs / 1000);
    }

    if (current > limit.max) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: limit.max,
        remaining: 0,
        reset: await redis.ttl(key)
      });
    }

    // Set rate limit headers
    res.set({
      'X-RateLimit-Limit': limit.max,
      'X-RateLimit-Remaining': limit.max - current,
      'X-RateLimit-Reset': await redis.ttl(key)
    });

    next();

};
}

app.use('/api/', authenticateToken, createTieredRateLimiter());
\`\`\`

### DDoS Protection with Helmet

\`\`\`javascript
const helmet = require('helmet');

app.use(helmet({
// Content Security Policy
contentSecurityPolicy: {
directives: {
defaultSrc: ["'self'"],
styleSrc: ["'self'", "'unsafe-inline'"],
scriptSrc: ["'self'"],
imgSrc: ["'self'", 'data:', 'https:']
}
},
// Prevent clickjacking
frameguard: { action: 'deny' },
// Hide X-Powered-By header
hidePoweredBy: true,
// Prevent MIME type sniffing
noSniff: true,
// Enable HSTS
hsts: {
maxAge: 31536000,
includeSubDomains: true,
preload: true
}
}));
\`\`\`

### Rate Limit Response Headers

\`\`\`
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1640000000
Retry-After: 900
\`\`\`
```

## Best Practices

### ✅ Do This

- **Use HTTPS Everywhere** - Never send sensitive data over HTTP
- **Implement Authentication** - Require authentication for protected endpoints
- **Validate All Inputs** - Never trust user input
- **Use Parameterized Queries** - Prevent SQL injection
- **Implement Rate Limiting** - Protect against brute force and DDoS
- **Hash Passwords** - Use bcrypt with salt rounds >= 10
- **Use Short-Lived Tokens** - JWT access tokens should expire quickly
- **Implement CORS Properly** - Only allow trusted origins
- **Log Security Events** - Monitor for suspicious activity
- **Keep Dependencies Updated** - Regularly update packages
- **Use Security Headers** - Implement Helmet.js
- **Sanitize Error Messages** - Don't leak sensitive information

### ❌ Don't Do This

- **Don't Store Passwords in Plain Text** - Always hash passwords
- **Don't Use Weak Secrets** - Use strong, random JWT secrets
- **Don't Trust User Input** - Always validate and sanitize
- **Don't Expose Stack Traces** - Hide error details in production
- **Don't Use String Concatenation for SQL** - Use parameterized queries
- **Don't Store Sensitive Data in JWT** - JWTs are not encrypted
- **Don't Ignore Security Updates** - Update dependencies regularly
- **Don't Use Default Credentials** - Change all default passwords
- **Don't Disable CORS Completely** - Configure it properly instead
- **Don't Log Sensitive Data** - Sanitize logs

## Common Pitfalls

### Problem: JWT Secret Exposed in Code

**Symptoms:** JWT secret hardcoded or committed to Git
**Solution:**
\`\`\`javascript
// ❌ Bad
const JWT_SECRET = 'my-secret-key';

// ✅ Good
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
throw new Error('JWT_SECRET environment variable is required');
}

// Generate strong secret
// node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
\`\`\`

### Problem: Weak Password Requirements

**Symptoms:** Users can set weak passwords like "password123"
**Solution:**
\`\`\`javascript
const passwordSchema = z.string()
.min(12, 'Password must be at least 12 characters')
.regex(/[A-Z]/, 'Must contain uppercase letter')
.regex(/[a-z]/, 'Must contain lowercase letter')
.regex(/[0-9]/, 'Must contain number')
.regex(/[^A-Za-z0-9]/, 'Must contain special character');

// Or use a password strength library
const zxcvbn = require('zxcvbn');
const result = zxcvbn(password);
if (result.score < 3) {
return res.status(400).json({
error: 'Password too weak',
suggestions: result.feedback.suggestions
});
}
\`\`\`

### Problem: Missing Authorization Checks

**Symptoms:** Users can access resources they shouldn't
**Solution:**
\`\`\`javascript
// ❌ Bad: Only checks authentication
app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
await prisma.post.delete({ where: { id: req.params.id } });
res.json({ success: true });
});

// ✅ Good: Checks both authentication and authorization
app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
const post = await prisma.post.findUnique({
where: { id: req.params.id }
});

if (!post) {
return res.status(404).json({ error: 'Post not found' });
}

// Check if user owns the post or is admin
if (post.userId !== req.user.userId && req.user.role !== 'admin') {
return res.status(403).json({
error: 'Not authorized to delete this post'
});
}

await prisma.post.delete({ where: { id: req.params.id } });
res.json({ success: true });
});
\`\`\`

### Problem: Verbose Error Messages

**Symptoms:** Error messages reveal system details
**Solution:**
\`\`\`javascript
// ❌ Bad: Exposes database details
app.post('/api/users', async (req, res) => {
try {
const user = await prisma.user.create({ data: req.body });
res.json(user);
} catch (error) {
res.status(500).json({ error: error.message });
// Error: "Unique constraint failed on the fields: (`email`)"
}
});

// ✅ Good: Generic error message
app.post('/api/users', async (req, res) => {
try {
const user = await prisma.user.create({ data: req.body });
res.json(user);
} catch (error) {
console.error('User creation error:', error); // Log full error

    if (error.code === 'P2002') {
      return res.status(400).json({
        error: 'Email already exists'
      });
    }

    res.status(500).json({
      error: 'An error occurred while creating user'
    });

}
});
\`\`\`

## Security Checklist

### Authentication & Authorization

- [ ] Implement strong authentication (JWT, OAuth 2.0)
- [ ] Use HTTPS for all endpoints
- [ ] Hash passwords with bcrypt (salt rounds >= 10)
- [ ] Implement token expiration
- [ ] Add refresh token mechanism
- [ ] Verify user authorization for each request
- [ ] Implement role-based access control (RBAC)

### Input Validation

- [ ] Validate all user inputs
- [ ] Use parameterized queries or ORM
- [ ] Sanitize HTML content
- [ ] Validate file uploads
- [ ] Implement request schema validation
- [ ] Use allowlists, not blocklists

### Rate Limiting & DDoS Protection

- [ ] Implement rate limiting per user/IP
- [ ] Add stricter limits for auth endpoints
- [ ] Use Redis for distributed rate limiting
- [ ] Return proper rate limit headers
- [ ] Implement request throttling

### Data Protection

- [ ] Use HTTPS/TLS for all traffic
- [ ] Encrypt sensitive data at rest
- [ ] Don't store sensitive data in JWT
- [ ] Sanitize error messages
- [ ] Implement proper CORS configuration
- [ ] Use security headers (Helmet.js)

### Monitoring & Logging

- [ ] Log security events
- [ ] Monitor for suspicious activity
- [ ] Set up alerts for failed auth attempts
- [ ] Track API usage patterns
- [ ] Don't log sensitive data

## OWASP API Security Top 10

1. **Broken Object Level Authorization** - Always verify user can access resource
2. **Broken Authentication** - Implement strong authentication mechanisms
3. **Broken Object Property Level Authorization** - Validate which properties user can access
4. **Unrestricted Resource Consumption** - Implement rate limiting and quotas
5. **Broken Function Level Authorization** - Verify user role for each function
6. **Unrestricted Access to Sensitive Business Flows** - Protect critical workflows
7. **Server Side Request Forgery (SSRF)** - Validate and sanitize URLs
8. **Security Misconfiguration** - Use security best practices and headers
9. **Improper Inventory Management** - Document and secure all API endpoints
10. **Unsafe Consumption of APIs** - Validate data from third-party APIs

## Related Skills

- `@ethical-hacking-methodology` - Security testing perspective
- `@sql-injection-testing` - Testing for SQL injection
- `@xss-html-injection` - Testing for XSS vulnerabilities
- `@broken-authentication` - Authentication vulnerabilities
- `@backend-dev-guidelines` - Backend development standards
- `@systematic-debugging` - Debug security issues

## Additional Resources

- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
- [API Security Checklist](https://github.com/shieldfy/API-Security-Checklist)

---

**Pro Tip:** Security is not a one-time task - regularly audit your APIs, keep dependencies updated, and stay informed about new vulnerabilities!
