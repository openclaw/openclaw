# Plugin Permissions Quick Reference

## Permission Fields

### Memory Limit

```json
{
  "permissions": {
    "memory": 128 // MB (default: 128, max: 512)
  }
}
```

### CPU Timeout

```json
{
  "permissions": {
    "cpu": 5000 // milliseconds (default: 5000, max: 30000)
  }
}
```

### Filesystem Access

```json
{
  "permissions": {
    "filesystem": {
      "read": ["/workspace/data", "/tmp/cache"],
      "write": ["/workspace/output"]
    }
  }
}
```

### Network Access

```json
{
  "permissions": {
    "network": {
      "allowlist": ["api.example.com"], // Only these domains
      "blocklist": ["evil.com"] // Never these domains
    }
  }
}
```

### Environment Variables

```json
{
  "permissions": {
    "env": true,
    "envVars": ["API_KEY", "API_SECRET"] // Only expose these vars
  }
}
```

### Node.js Modules (Use Sparingly)

```json
{
  "permissions": {
    "nativeModules": true,
    "allowedModules": ["path", "util"] // Only these modules
  }
}
```

## Complete Example

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Example plugin with permissions",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" }
    },
    "required": ["apiKey"]
  },
  "permissions": {
    "memory": 256,
    "cpu": 10000,
    "filesystem": {
      "read": ["/workspace/plugin-data"],
      "write": ["/workspace/plugin-output"]
    },
    "network": {
      "allowlist": ["api.myservice.com", "cdn.myservice.com"]
    },
    "env": true,
    "envVars": ["MY_PLUGIN_SECRET"]
  }
}
```

## Permission Validation Rules

1. **Memory**:
   - Must be positive number
   - Maximum: 512MB
   - Default: 128MB

2. **CPU**:
   - Must be positive number
   - Maximum: 30000ms (30 seconds)
   - Default: 5000ms (5 seconds)

3. **Filesystem**:
   - Paths must be absolute
   - Wildcards not supported
   - Subdirectories automatically included

4. **Network**:
   - Domain names only (no IPs)
   - Exact match or substring match
   - Blocklist takes precedence over allowlist

5. **Environment**:
   - Must specify `env: true` to access any variables
   - If `envVars` is empty, all vars are accessible
   - If `envVars` has items, only those are accessible

## Security Checklist

- [ ] Request minimum required memory
- [ ] Request minimum required CPU time
- [ ] Only request filesystem access if absolutely necessary
- [ ] Use specific paths, not broad directories
- [ ] Only allowlist specific domains for network
- [ ] Only expose required environment variables
- [ ] Avoid `nativeModules` if possible
- [ ] Document why each permission is needed

## Common Patterns

### API Client Plugin

```json
{
  "permissions": {
    "network": {
      "allowlist": ["api.example.com"]
    },
    "env": true,
    "envVars": ["EXAMPLE_API_KEY"]
  }
}
```

### Data Processing Plugin

```json
{
  "permissions": {
    "memory": 256,
    "cpu": 15000,
    "filesystem": {
      "read": ["/workspace/input"],
      "write": ["/workspace/output"]
    }
  }
}
```

### Monitoring Plugin

```json
{
  "permissions": {
    "memory": 64,
    "cpu": 2000,
    "network": {
      "allowlist": ["metrics.example.com"]
    }
  }
}
```

## Troubleshooting

### Error: "Module 'fs' is not allowed"

**Solution**: Either refactor to not use `fs`, or add:

```json
{
  "permissions": {
    "nativeModules": true,
    "allowedModules": ["fs"]
  }
}
```

### Error: "Plugin exceeded CPU time limit"

**Solution**: Increase CPU limit or optimize code:

```json
{
  "permissions": {
    "cpu": 10000
  }
}
```

### Error: "Plugin does not have permission to read file"

**Solution**: Add filesystem read permission:

```json
{
  "permissions": {
    "filesystem": {
      "read": ["/path/to/file"]
    }
  }
}
```
