# HTTP Security Quick Reference

## 🚀 Quick Start

### Webhook Endpoint (Simple)

```typescript
import { webhookSecurity } from "../../src/plugins/http-security-middleware.js";

const middleware = webhookSecurity({ rateLimit: { max: 50 } });

http
  .createServer((req, res) => {
    middleware(req, res, () => {
      // Your handler
    });
  })
  .listen(port);
```

### API Endpoint (Full Protection)

```typescript
import { apiSecurity, body } from "../../src/plugins/http-security-middleware.js";

const middleware = apiSecurity({
  csrf: true,
  requireAuth: true,
  authOptions: { validTokens: ["token"] },
  validation: [body("email").isEmail()],
});

http
  .createServer((req, res) => {
    middleware(req, res, () => {
      // Your handler
    });
  })
  .listen(port);
```

### Express App

```typescript
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"] },
    },
    hsts: { maxAge: 31536000 },
  }),
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  }),
);

app.use(express.json());
```

## 🔒 Security Features

| Feature        | Function            | Usage                            |
| -------------- | ------------------- | -------------------------------- |
| **Headers**    | `securityHeaders()` | XSS, clickjacking, MIME sniffing |
| **Rate Limit** | `rateLimiter()`     | DoS protection                   |
| **CSRF**       | `CsrfProtection`    | CSRF token validation            |
| **Auth**       | `requireAuth()`     | Bearer token, IP whitelist       |
| **Validation** | `validateInput()`   | Schema-based input check         |
| **Body Parse** | `jsonBodyParser()`  | JSON parsing with limits         |

## 📋 Common Patterns

### Chain Multiple Middlewares

```typescript
import { chain, securityHeaders, rateLimiter, requireAuth } from "...";

const middleware = chain(
  securityHeaders(),
  rateLimiter({ max: 50 }),
  requireAuth({ validTokens: ["token"] }),
);
```

### Input Validation

```typescript
import { validateInput, body } from "...";

validateInput([
  body("email").isEmail().normalizeEmail(),
  body("age").isInt({ min: 0, max: 120 }),
  body("username").isAlphanumeric().isLength({ min: 3 }),
]);
```

### CSRF Protection

```typescript
const csrf = new CsrfProtection();
const middleware = csrf.middleware();

// Client must send token in header:
// x-csrf-token: <token from cookie>
```

### Authentication

```typescript
// Bearer token
requireAuth({
  requireBearerToken: true,
  validTokens: ["secret"],
});

// IP whitelist
requireAuth({
  allowedIPs: ["127.0.0.1"],
});

// Custom
requireAuth({
  verify: async (req) => {
    return await checkAuth(req);
  },
});
```

## ⚡ Rate Limits

| Endpoint Type | Limit    | Window |
| ------------- | -------- | ------ |
| Webhooks      | 50 req   | 15 min |
| APIs          | 100 req  | 15 min |
| Public        | 1000 req | 15 min |

## ✅ Security Checklist

- [ ] Security headers (helmet)
- [ ] Rate limiting (50-100 req/15min)
- [ ] Input validation
- [ ] Authentication
- [ ] CSRF protection (if state-changing)
- [ ] Body size limits
- [ ] HTTPS (HSTS)
- [ ] Error handling
- [ ] Tests written

## 🧪 Testing

```typescript
describe("Security", () => {
  it("should reject without auth", async () => {
    const res = await fetch("/api");
    expect(res.status).toBe(401);
  });

  it("should enforce rate limit", async () => {
    const responses = await Promise.all(
      Array(51)
        .fill(0)
        .map(() => fetch("/api")),
    );
    expect(responses.some((r) => r.status === 429)).toBe(true);
  });

  it("should validate input", async () => {
    const res = await fetch("/api", {
      method: "POST",
      body: JSON.stringify({ email: "invalid" }),
    });
    expect(res.status).toBe(400);
  });
});
```

## 🔥 Common Mistakes

### ❌ No Security

```typescript
http.createServer((req, res) => {
  handleRequest(req, res); // VULNERABLE!
});
```

### ✅ With Security

```typescript
const middleware = webhookSecurity();
http.createServer((req, res) => {
  middleware(req, res, () => {
    handleRequest(req, res);
  });
});
```

### ❌ Missing Rate Limit

```typescript
app.post("/webhook", handler); // Can be DoS'd
```

### ✅ With Rate Limit

```typescript
app.use(rateLimit({ max: 50 }));
app.post("/webhook", handler);
```

### ❌ No Input Validation

```typescript
app.post("/api", (req, res) => {
  db.query(req.body.email); // SQL injection risk!
});
```

### ✅ With Validation

```typescript
app.post("/api", validateInput([body("email").isEmail()]), (req, res) => {
  db.query(req.body.email); // Safe
});
```

## 📚 Validators

| Validator          | Usage             | Example                                |
| ------------------ | ----------------- | -------------------------------------- |
| `isEmail()`        | Email address     | `user@example.com`                     |
| `isURL()`          | URL               | `https://example.com`                  |
| `isUUID()`         | UUID              | `123e4567-e89b-12d3-a456-426614174000` |
| `isInt()`          | Integer           | `42`                                   |
| `isAlphanumeric()` | Letters + numbers | `user123`                              |
| `isLength()`       | String length     | `{ min: 3, max: 20 }`                  |
| `notEmpty()`       | Non-empty         | Not `""`                               |
| `optional()`       | Optional field    | Can be undefined                       |

## 🌐 Headers Set

```
Content-Security-Policy: default-src 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
RateLimit-Limit: 100
RateLimit-Remaining: 99
RateLimit-Reset: 1645034400
```

## 🆘 Support

- 📖 Full Guide: `/docs/security/http-security-guide.md`
- 🧪 Tests: `/test/security/http-security.test.ts`
- 📝 Implementation: `/SECURITY-HTTP-IMPLEMENTATION.md`
- 💬 Discord: https://discord.gg/openclaw
- 🐛 Issues: https://github.com/openclaw/openclaw/issues
