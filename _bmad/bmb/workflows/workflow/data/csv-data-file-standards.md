# CSV Data File Standards

## When to Use CSV

Use for:

- Domain-specific data not in training data
- Too large for prompt context
- Structured lookup/reference needs
- Cross-session consistency required

**Don't use for:** Web-searchable info, common syntax, general knowledge, LLM-generatable content

## CSV Structure

```csv
category,name,pattern,description
"collaboration","Think Aloud Protocol","user speaks thoughts → facilitator captures","Make thinking visible during work"
```

**Rules:**

- Header row required, descriptive column names
- Consistent data types per column
- UTF-8 encoding
- All columns must be used in workflow

## Common Use Cases

### Method Registry

```csv
category,name,pattern
collaboration,Think Aloud,user speaks thoughts → facilitator captures
advanced,Six Thinking Hats,view problem from 6 perspectives
```

### Knowledge Base Index

```csv
keywords,document_path,section
"nutrition,macros",data/nutrition-reference.md,## Daily Targets
```

### Configuration Lookup

```csv
scenario,required_steps,output_sections
"2D Platformer",step-01,step-03,step-07,movement,physics,collision
```

## Best Practices

- Keep files small (<1MB preferred)
- No unused columns
- Use efficient encoding (codes vs full descriptions)
- Document purpose
- Validate data quality
