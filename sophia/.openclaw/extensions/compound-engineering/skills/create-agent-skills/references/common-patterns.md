<overview>
This reference documents common patterns for skill authoring, including templates, examples, terminology consistency, and anti-patterns. All patterns use pure XML structure.
</overview>

<template_pattern>
<description>
Provide templates for output format. Match the level of strictness to your needs.
</description>

<strict_requirements>
Use when output format must be exact and consistent:

```xml
<report_structure>
ALWAYS use this exact template structure:

```markdown
# [Analysis Title]

## Executive summary
[One-paragraph overview of key findings]

## Key findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```
</report_structure>
```

**When to use**: Compliance reports, standardized formats, automated processing
</strict_requirements>

<flexible_guidance>
Use when Claude should adapt the format based on context:

```xml
<report_structure>
Here is a sensible default format, but use your best judgment:

```markdown
# [Analysis Title]

## Executive summary
[Overview]

## Key findings
[Adapt sections based on what you discover]

## Recommendations
[Tailor to the specific context]
```

Adjust sections as needed for the specific analysis type.
</report_structure>
```

**When to use**: Exploratory analysis, context-dependent formatting, creative tasks
</flexible_guidance>
</template_pattern>

<examples_pattern>
<description>
For skills where output quality depends on seeing examples, provide input/output pairs.
</description>

<commit_messages_example>
```xml
<objective>
Generate commit messages following conventional commit format.
</objective>

<commit_message_format>
Generate commit messages following these examples:

<example number="1">
<input>Added user authentication with JWT tokens</input>
<output>
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```
</output>
</example>

<example number="2">
<input>Fixed bug where dates displayed incorrectly in reports</input>
<output>
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```
</output>
</example>

Follow this style: type(scope): brief description, then detailed explanation.
</commit_message_format>
```
</commit_messages_example>

<when_to_use>
- Output format has nuances that text explanations can't capture
- Pattern recognition is easier than rule following
- Examples demonstrate edge cases
- Multi-shot learning improves quality
</when_to_use>
</examples_pattern>

<consistent_terminology>
<principle>
Choose one term and use it throughout the skill. Inconsistent terminology confuses Claude and reduces execution quality.
</principle>

<good_example>
Consistent usage:
- Always "API endpoint" (not mixing with "URL", "API route", "path")
- Always "field" (not mixing with "box", "element", "control")
- Always "extract" (not mixing with "pull", "get", "retrieve")

```xml
<objective>
Extract data from API endpoints using field mappings.
</objective>

<quick_start>
1. Identify the API endpoint
2. Map response fields to your schema
3. Extract field values
</quick_start>
```
</good_example>

<bad_example>
Inconsistent usage creates confusion:

```xml
<objective>
Pull data from API routes using element mappings.
</objective>

<quick_start>
1. Identify the URL
2. Map response boxes to your schema
3. Retrieve control values
</quick_start>
```

Claude must now interpret: Are "API routes" and "URLs" the same? Are "fields", "boxes", "elements", and "controls" the same?
</bad_example>

<implementation>
1. Choose terminology early in skill development
2. Document key terms in `<objective>` or `<context>`
3. Use find/replace to enforce consistency
4. Review reference files for consistent usage
</implementation>
</consistent_terminology>

<provide_default_with_escape_hatch>
<principle>
Provide a default approach with an escape hatch for special cases, not a list of alternatives. Too many options paralyze decision-making.
</principle>

<good_example>
Clear default with escape hatch:

```xml
<quick_start>
Use pdfplumber for text extraction:

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

For scanned PDFs requiring OCR, use pdf2image with pytesseract instead.
</quick_start>
```
</good_example>

<bad_example>
Too many options creates decision paralysis:

```xml
<quick_start>
You can use any of these libraries:

- **pypdf**: Good for basic extraction
- **pdfplumber**: Better for tables
- **PyMuPDF**: Faster but more complex
- **pdf2image**: For scanned documents
- **pdfminer**: Low-level control
- **tabula-py**: Table-focused

Choose based on your needs.
</quick_start>
```

Claude must now research and compare all options before starting. This wastes tokens and time.
</bad_example>

<implementation>
1. Recommend ONE default approach
2. Explain when to use the default (implied: most of the time)
3. Add ONE escape hatch for edge cases
4. Link to advanced reference if multiple alternatives truly needed
</implementation>
</provide_default_with_escape_hatch>

<anti_patterns>
<description>
Common mistakes to avoid when authoring skills.
</description>

<pitfall name="markdown_headings_in_body">
❌ **BAD**: Using markdown headings in skill body:

```markdown
# PDF Processing

## Quick start
Extract text with pdfplumber...

## Advanced features
Form filling requires additional setup...
```

✅ **GOOD**: Using pure XML structure:

```xml
<objective>
PDF processing with text extraction, form filling, and merging capabilities.
</objective>

<quick_start>
Extract text with pdfplumber...
</quick_start>

<advanced_features>
Form filling requires additional setup...
</advanced_features>
```

**Why it matters**: XML provides semantic meaning, reliable parsing, and token efficiency.
</pitfall>

<pitfall name="vague_descriptions">
❌ **BAD**:
```yaml
description: Helps with documents
```

✅ **GOOD**:
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Why it matters**: Vague descriptions prevent Claude from discovering and using the skill appropriately.
</pitfall>

<pitfall name="inconsistent_pov">
❌ **BAD**:
```yaml
description: I can help you process Excel files and generate reports
```

✅ **GOOD**:
```yaml
description: Processes Excel files and generates reports. Use when analyzing spreadsheets or .xlsx files.
```

**Why it matters**: Skills must use third person. First/second person breaks the skill metadata pattern.
</pitfall>

<pitfall name="wrong_naming_convention">
❌ **BAD**: Directory name doesn't match skill name or verb-noun convention:
- Directory: `facebook-ads`, Name: `facebook-ads-manager`
- Directory: `stripe-integration`, Name: `stripe`
- Directory: `helper-scripts`, Name: `helper`

✅ **GOOD**: Consistent verb-noun convention:
- Directory: `manage-facebook-ads`, Name: `manage-facebook-ads`
- Directory: `setup-stripe-payments`, Name: `setup-stripe-payments`
- Directory: `process-pdfs`, Name: `process-pdfs`

**Why it matters**: Consistency in naming makes skills discoverable and predictable.
</pitfall>

<pitfall name="too_many_options">
❌ **BAD**:
```xml
<quick_start>
You can use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or pdfminer, or tabula-py...
</quick_start>
```

✅ **GOOD**:
```xml
<quick_start>
Use pdfplumber for text extraction:

```python
import pdfplumber
```

For scanned PDFs requiring OCR, use pdf2image with pytesseract instead.
</quick_start>
```

**Why it matters**: Decision paralysis. Provide one default approach with escape hatch for special cases.
</pitfall>

<pitfall name="deeply_nested_references">
❌ **BAD**: References nested multiple levels:
```
SKILL.md → advanced.md → details.md → examples.md
```

✅ **GOOD**: References one level deep from SKILL.md:
```
SKILL.md → advanced.md
SKILL.md → details.md
SKILL.md → examples.md
```

**Why it matters**: Claude may only partially read deeply nested files. Keep references one level deep from SKILL.md.
</pitfall>

<pitfall name="windows_paths">
❌ **BAD**:
```xml
<reference_guides>
See scripts\validate.py for validation
</reference_guides>
```

✅ **GOOD**:
```xml
<reference_guides>
See scripts/validate.py for validation
</reference_guides>
```

**Why it matters**: Always use forward slashes for cross-platform compatibility.
</pitfall>

<pitfall name="dynamic_context_and_file_reference_execution">
**Problem**: When showing examples of dynamic context syntax (exclamation mark + backticks) or file references (@ prefix), the skill loader executes these during skill loading.

❌ **BAD** - These execute during skill load:
```xml
<examples>
Load current status with: !`git status`
Review dependencies in: @package.json
</examples>
```

✅ **GOOD** - Add space to prevent execution:
```xml
<examples>
Load current status with: ! `git status` (remove space before backtick in actual usage)
Review dependencies in: @ package.json (remove space after @ in actual usage)
</examples>
```

**When this applies**:
- Skills that teach users about dynamic context (slash commands, prompts)
- Any documentation showing the exclamation mark prefix syntax or @ file references
- Skills with example commands or file paths that shouldn't execute during loading

**Why it matters**: Without the space, these execute during skill load, causing errors or unwanted file reads.
</pitfall>

<pitfall name="missing_required_tags">
❌ **BAD**: Missing required tags:
```xml
<quick_start>
Use this tool for processing...
</quick_start>
```

✅ **GOOD**: All required tags present:
```xml
<objective>
Process data files with validation and transformation.
</objective>

<quick_start>
Use this tool for processing...
</quick_start>

<success_criteria>
- Input file successfully processed
- Output file validates without errors
- Transformation applied correctly
</success_criteria>
```

**Why it matters**: Every skill must have `<objective>`, `<quick_start>`, and `<success_criteria>` (or `<when_successful>`).
</pitfall>

<pitfall name="hybrid_xml_markdown">
❌ **BAD**: Mixing XML tags with markdown headings:
```markdown
<objective>
PDF processing capabilities
</objective>

## Quick start

Extract text with pdfplumber...

## Advanced features

Form filling...
```

✅ **GOOD**: Pure XML throughout:
```xml
<objective>
PDF processing capabilities
</objective>

<quick_start>
Extract text with pdfplumber...
</quick_start>

<advanced_features>
Form filling...
</advanced_features>
```

**Why it matters**: Consistency in structure. Either use pure XML or pure markdown (prefer XML).
</pitfall>

<pitfall name="unclosed_xml_tags">
❌ **BAD**: Forgetting to close XML tags:
```xml
<objective>
Process PDF files

<quick_start>
Use pdfplumber...
</quick_start>
```

✅ **GOOD**: Properly closed tags:
```xml
<objective>
Process PDF files
</objective>

<quick_start>
Use pdfplumber...
</quick_start>
```

**Why it matters**: Unclosed tags break XML parsing and create ambiguous boundaries.
</pitfall>
</anti_patterns>

<progressive_disclosure_pattern>
<description>
Keep SKILL.md concise by linking to detailed reference files. Claude loads reference files only when needed.
</description>

<implementation>
```xml
<objective>
Manage Facebook Ads campaigns, ad sets, and ads via the Marketing API.
</objective>

<quick_start>
<basic_operations>
See [basic-operations.md](basic-operations.md) for campaign creation and management.
</basic_operations>
</quick_start>

<advanced_features>
**Custom audiences**: See [audiences.md](audiences.md)
**Conversion tracking**: See [conversions.md](conversions.md)
**Budget optimization**: See [budgets.md](budgets.md)
**API reference**: See [api-reference.md](api-reference.md)
</advanced_features>
```

**Benefits**:
- SKILL.md stays under 500 lines
- Claude only reads relevant reference files
- Token usage scales with task complexity
- Easier to maintain and update
</implementation>
</progressive_disclosure_pattern>

<validation_pattern>
<description>
For skills with validation steps, make validation scripts verbose and specific.
</description>

<implementation>
```xml
<validation>
After making changes, validate immediately:

```bash
python scripts/validate.py output_dir/
```

If validation fails, fix errors before continuing. Validation errors include:

- **Field not found**: "Field 'signature_date' not found. Available fields: customer_name, order_total, signature_date_signed"
- **Type mismatch**: "Field 'order_total' expects number, got string"
- **Missing required field**: "Required field 'customer_name' is missing"

Only proceed when validation passes with zero errors.
</validation>
```

**Why verbose errors help**:
- Claude can fix issues without guessing
- Specific error messages reduce iteration cycles
- Available options shown in error messages
</implementation>
</validation_pattern>

<checklist_pattern>
<description>
For complex multi-step workflows, provide a checklist Claude can copy and track progress.
</description>

<implementation>
```xml
<workflow>
Copy this checklist and check off items as you complete them:

```
Task Progress:
- [ ] Step 1: Analyze the form (run analyze_form.py)
- [ ] Step 2: Create field mapping (edit fields.json)
- [ ] Step 3: Validate mapping (run validate_fields.py)
- [ ] Step 4: Fill the form (run fill_form.py)
- [ ] Step 5: Verify output (run verify_output.py)
```

<step_1>
**Analyze the form**

Run: `python scripts/analyze_form.py input.pdf`

This extracts form fields and their locations, saving to `fields.json`.
</step_1>

<step_2>
**Create field mapping**

Edit `fields.json` to add values for each field.
</step_2>

<step_3>
**Validate mapping**

Run: `python scripts/validate_fields.py fields.json`

Fix any validation errors before continuing.
</step_3>

<step_4>
**Fill the form**

Run: `python scripts/fill_form.py input.pdf fields.json output.pdf`
</step_4>

<step_5>
**Verify output**

Run: `python scripts/verify_output.py output.pdf`

If verification fails, return to Step 2.
</step_5>
</workflow>
```

**Benefits**:
- Clear progress tracking
- Prevents skipping steps
- Easy to resume after interruption
</implementation>
</checklist_pattern>
