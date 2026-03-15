# Tool Usage Notes

## Memory Tools

### memory_search
- Use `vsearch` mode for semantic/conceptual searches
- Use `search` mode for keyword-based lookups
- Use `query` mode for natural language questions
- Limit results appropriately (5-10 for context, more for comprehensive review)

### memory_add
- Include descriptive metadata for better retrieval
- Use consistent tagging conventions
- Store atomic facts rather than large documents
- Reference source sessions or files when applicable

## File Operations

### read
- Read files before editing to understand context
- Use for configuration review and debugging
- Check file existence before operations

### edit / write
- Prefer `edit` for modifications (preserves structure)
- Use `write` for new files or complete rewrites
- Always verify changes after writing

## Search Tools

### glob
- Use for finding files by pattern
- Efficient for known file structures
- Combine with read for content inspection

### grep
- Use for content search across files
- Regular expressions for complex patterns
- Combine with glob for targeted searches

## Execution

### exec
- Use for system commands and builds
- Capture output for debugging
- Handle errors gracefully
- Document command purpose

## Best Practices

1. **Research first**: Use search tools before making changes
2. **Persist knowledge**: Store important findings in memory
3. **Verify changes**: Read files after modifications
4. **Document reasoning**: Store decision context for future sessions
