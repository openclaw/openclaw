# HTTP Security Guide for Extension Developers

## Overview

All OpenClaw extensions that expose HTTP endpoints **must** implement comprehensive security controls to protect against common web vulnerabilities. This guide covers the security middleware available and how to properly integrate it into your extensions.

## Threat Model

HTTP endpoints in extensions are vulnerable to:

- **Cross-Site Scripting (XSS)** - CVSS 6.1
- **Cross-Site Request Forgery (CSRF)** - CVSS 8.8
- **Clickjacking** - CVSS 4.3
- **MIME-type sniffing** - CVSS 5.3
- **Rate limiting/DoS** - CVSS 7.5
- **Host header injection** - CVSS 5.3
- **Missing authentication** - CVSS 9.8

**Combined CVSS Score: 7.5 (HIGH)**

## Security Middleware

OpenClaw provides a comprehensive HTTP security middleware at `src/plugins/http-security-middleware.ts`.

### Quick Start

#### Webhook Endpoints (Simple)

For webhook receivers (e.g., Slack, Discord, GitHub):

```typescript
import { webhookSecurity } from "../../../src/plugins/http-security-middleware.js";

const server = http.createServer((req, res) => {
  const securityMiddleware = webhookSecurity({ rateLimit: { max: 50 } });

  securityMiddleware(req, res, () => {
    // Your webhook handler
    handleWebhook(req, res);
  });
});
```

#### API Endpoints (Full Protection)

For API endpoints with CSRF protection:

```typescript
import { apiSecurity, body } from "../../../src/plugins/http-security-middleware.js";

const server = http.createServer((req, res) => {
  const securityMiddleware = apiSecurity({
    csrf: true,
    requireAuth: true,
    authOptions: {
      validTokens: ["your-secret-token"],
    },
    validation: [body("email").isEmail(), body("message").isString().notEmpty()],
  });

  securityMiddleware(req, res, () => {
    // Your API handler
    handleApiRequest(req, res);
  });
});
```

## Security Features

### 1. Security Headers (Helmet)

Automatically applied by all presets. Provides:

- **Content Security Policy (CSP)** - Prevents XSS
- **Strict-Transport-Security (HSTS)** - Enforces HTTPS
- **X-Frame-Options** - Prevents clickjacking
- **X-Content-Type-Options** - Prevents MIME sniffing
- **X-XSS-Protection** - Legacy XSS protection
- **Referrer-Policy** - Controls referrer information

### 2. Rate Limiting

Protects against DoS attacks by limiting requests per IP:

```typescript
import { rateLimiter } from "../../../src/plugins/http-security-middleware.js";

const limiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: "Too many requests",
});
```

**Default limits:**

- Webhooks: 50 requests per 15 minutes
- APIs: 100 requests per 15 minutes

### 3. CSRF Protection

Modern double-submit cookie pattern (replaces deprecated `csurf`):

```typescript
import { CsrfProtection } from "../../../src/plugins/http-security-middleware.js";

const csrf = new CsrfProtection({
  secret: process.env.CSRF_SECRET,
  cookieName: "__Host-openclaw-csrf",
});

const middleware = csrf.middleware();
```

**How it works:**

1. GET requests automatically receive a CSRF token in a cookie
2. POST/PUT/DELETE requests must include:
   - Token in cookie
   - Same token in `x-csrf-token` header
3. Tokens are HMAC-signed to prevent tampering

**Client-side usage:**

```javascript
// Get token from cookie
const token = document.cookie
  .split("; ")
  .find((row) => row.startsWith("__Host-openclaw-csrf="))
  ?.split("=")[1];

// Include in requests
fetch("/api/endpoint", {
  method: "POST",
  headers: {
    "x-csrf-token": token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(data),
});
```

### 4. Input Validation

Uses `express-validator` for schema-based validation:

```typescript
import { validateInput, body } from "../../../src/plugins/http-security-middleware.js";

const middleware = validateInput([
  body("email").isEmail().normalizeEmail(),
  body("age").isInt({ min: 0, max: 120 }),
  body("username").isAlphanumeric().isLength({ min: 3, max: 20 }),
  body("url").optional().isURL(),
]);
```

**Common validators:**

- `isEmail()` - Valid email address
- `isURL()` - Valid URL
- `isUUID()` - Valid UUID
- `isInt()` - Integer with optional min/max
- `isAlphanumeric()` - Only letters and numbers
- `isLength()` - String length constraints
- `notEmpty()` - Non-empty string

### 5. Authentication

Flexible authentication middleware:

```typescript
import { requireAuth } from "../../../src/plugins/http-security-middleware.js";

// Bearer token auth
const middleware = requireAuth({
  requireBearerToken: true,
  validTokens: ["secret-token-1", "secret-token-2"],
});

// IP whitelist
const middleware = requireAuth({
  allowedIPs: ["127.0.0.1", "192.168.1.100"],
});

// Custom verification
const middleware = requireAuth({
  verify: async (req) => {
    const sessionId = req.headers["x-session-id"];
    return await isValidSession(sessionId);
  },
});
```

### 6. Body Parser

Parses JSON request bodies with size limits:

```typescript
import { jsonBodyParser } from "../../../src/plugins/http-security-middleware.js";

const middleware = jsonBodyParser({
  maxSize: 1024 * 1024, // 1MB
  timeout: 30000, // 30 seconds
});
```

## Extension Integration Examples

### Express-based Extension (MS Teams)

```typescript
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
  }),
);

// Rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Body parsing
app.use(express.json());

// Your routes
app.post("/webhook", handler);
```

### Node HTTP Server (Voice Call)

```typescript
import http from "http";
import { webhookSecurity } from "../../../src/plugins/http-security-middleware.js";

const securityMiddleware = webhookSecurity({ rateLimit: { max: 50 } });

const server = http.createServer((req, res) => {
  securityMiddleware(req, res, () => {
    handleRequest(req, res).catch((err) => {
      console.error("Request error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });
});

server.listen(port);
```

### Lark/Feishu SDK Wrapper

```typescript
import http from "http";
import { webhookSecurity } from "../../../src/plugins/http-security-middleware.js";
import { adaptDefault } from "@larksuiteoapi/node-sdk";

const securityMiddleware = webhookSecurity({ rateLimit: { max: 50 } });
const larkHandler = adaptDefault(path, eventDispatcher, { autoChallenge: true });

const server = http.createServer((req, res) => {
  securityMiddleware(req, res, () => {
    larkHandler(req, res);
  });
});
```

## Middleware Chaining

Chain multiple middlewares together:

```typescript
import {
  chain,
  securityHeaders,
  rateLimiter,
  jsonBodyParser,
  validateInput,
  requireAuth,
  body,
} from "../../../src/plugins/http-security-middleware.js";

const middleware = chain(
  securityHeaders(),
  rateLimiter({ max: 50 }),
  jsonBodyParser(),
  requireAuth({ validTokens: ["token"] }),
  validateInput([body("data").isObject()]),
);

server = http.createServer((req, res) => {
  middleware(req, res, () => {
    // All security checks passed
    handleSecureRequest(req, res);
  });
});
```

## Testing Security

Always test your security implementation:

```typescript
import { describe, it, expect } from "vitest";

describe("Webhook Security", () => {
  it("should reject requests without auth", async () => {
    const response = await fetch("http://localhost:8080/webhook", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("should enforce rate limits", async () => {
    // Make 51 requests
    const responses = await Promise.all(
      Array(51)
        .fill(0)
        .map(() =>
          fetch("http://localhost:8080/webhook", {
            method: "POST",
            headers: { Authorization: "Bearer token" },
          }),
        ),
    );

    const rateLimited = responses.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });

  it("should validate input", async () => {
    const response = await fetch("http://localhost:8080/api/endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invalid" }),
    });
    expect(response.status).toBe(400);
  });
});
```

## Security Checklist

Before deploying an extension with HTTP endpoints:

- [ ] Security headers applied (helmet)
- [ ] Rate limiting configured (max 50-100 req/15min)
- [ ] Input validation on all POST/PUT endpoints
- [ ] Authentication required for sensitive endpoints
- [ ] CSRF protection on state-changing operations
- [ ] Request body size limits enforced
- [ ] Error messages don't leak sensitive info
- [ ] HTTPS enforced in production (HSTS)
- [ ] Security tests written and passing

## Best Practices

### 1. Defense in Depth

Don't rely on a single security control. Layer multiple protections:

```typescript
const middleware = chain(
  securityHeaders(), // Defense: XSS, clickjacking
  rateLimiter(), // Defense: DoS
  requireAuth(), // Defense: Unauthorized access
  csrf.middleware(), // Defense: CSRF
  validateInput(schema), // Defense: Injection attacks
);
```

### 2. Principle of Least Privilege

Only grant the minimum necessary access:

```typescript
// Good: Whitelist specific IPs
requireAuth({ allowedIPs: ["10.0.0.5"] });

// Bad: Allow all internal IPs
requireAuth({ allowedIPs: ["10.0.0.0/8"] });
```

### 3. Fail Securely

On error, deny access rather than allowing:

```typescript
const middleware = requireAuth({
  verify: async (req) => {
    try {
      return await checkAuth(req);
    } catch (err) {
      // Fail securely - deny on error
      console.error("Auth check failed:", err);
      return false;
    }
  },
});
```

### 4. Log Security Events

Log authentication failures and rate limit hits:

```typescript
rateLimiter({
  max: 50,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded from IP: ${req.socket.remoteAddress}`);
    res.statusCode = 429;
    res.end(JSON.stringify({ error: "Too many requests" }));
  },
});
```

### 5. Keep Dependencies Updated

Regularly update security dependencies:

```bash
pnpm update helmet express-rate-limit express-validator
```

## Vulnerability Disclosure

If you discover a security vulnerability in OpenClaw's HTTP security middleware:

1. **Do not** open a public issue
2. Email security@openclaw.ai with details
3. Allow 90 days for patch development
4. Coordinate public disclosure

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Helmet.js Documentation](https://helmetjs.github.io/)
- [Express Rate Limit](https://github.com/express-rate-limit/express-rate-limit)
- [Express Validator](https://express-validator.github.io/docs/)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

## Support

For questions about implementing HTTP security:

- Documentation: https://docs.openclaw.ai/security
- Discord: https://discord.gg/openclaw
- GitHub Issues: https://github.com/openclaw/openclaw/issues
