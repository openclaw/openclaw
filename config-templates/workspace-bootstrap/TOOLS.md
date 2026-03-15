# Available Tools

## Memory Tools

### Memory Search
Search persistent memory for relevant context.
```
Query: "previous architecture decisions"
Returns: Relevant memories with similarity scores
```

### Memory Add
Store new information in persistent memory.
```
Content: "User prefers functional programming style"
Metadata: { category: "preference", confidence: "high" }
```

## Browser Tools

### Navigate
Open a URL in the controlled browser.
```
URL: "https://example.com"
Profile: "default"
```

### Click / Type
Interact with page elements.
```
Selector: "#submit-button"
Text: "Hello world" (for type)
```

### Screenshot / Snapshot
Capture current page state.
```
Format: "png" | "jpeg"
FullPage: true | false
```

## Workspace Tools

### Read File
Read files from the workspace.
```
Path: "src/index.ts"
Encoding: "utf-8"
```

### List Files
List files in directories.
```
Path: "src"
Pattern: "*.ts"
```

## Agent Tools

### Send Message
Communicate with other agents or users.
```
To: "agent:research"
Content: "Find all API endpoints"
```

### Execute Skill
Run registered skills.
```
Skill: "commit"
Args: "-m 'Add feature'"
```

## Best Practices

1. Search memory before making assumptions
2. Use browser tools for web research when needed
3. Keep workspace operations within bounds
4. Log important decisions to memory
