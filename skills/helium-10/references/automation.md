# Browser Automation for Helium 10

Strategies for automating Helium 10 via browser control.

## Known Challenges

### Cerebro Input Field
The Cerebro search input uses a React autocomplete/combo-box that causes issues:
- Typed characters get mangled with autocomplete suggestions
- Input merges keystrokes with previous values
- Standard typing automation produces corrupted ASINs

### Session/Auth
- Requires login (cookies must persist)
- Session timeout after inactivity
- Some tools require paid plan access

## Reliable Automation Patterns

### Pattern 1: Direct URL Navigation

Navigate directly to tool with parameters when possible:

```
# Cerebro with ASIN (may not always trigger search)
https://members.helium10.com/cerebro?asin=B0BKH9QVT3

# Black Box with marketplace
https://members.helium10.com/black-box?marketplace=us
```

### Pattern 2: JavaScript Input Injection

Instead of typing, set values via JavaScript:

```javascript
// Find the input element (selector may vary)
const input = document.querySelector('input[placeholder*="ASIN"]')
  || document.querySelector('[data-testid="cerebro-input"]')
  || document.querySelector('.asin-input');

if (input) {
  // Clear existing value
  input.value = '';
  
  // Set new value
  input.value = 'B0BKH9QVT3';
  
  // Trigger React change detection
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(input, 'B0BKH9QVT3');
  
  // Dispatch events
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
```

### Pattern 3: Chrome Extension Workflow

Use Xray to open Cerebro with pre-filled ASIN:

1. Navigate to Amazon product page
2. Open Xray via extension
3. Click "Keywords" link for the product
4. Cerebro opens with ASIN already loaded
5. Click "Get Keywords"

This bypasses the problematic input field entirely.

### Pattern 4: Multi-ASIN Batch via Xray

1. Navigate to Amazon search results
2. Run Xray
3. Select multiple products (checkboxes)
4. Click "Run keyword search"
5. Cerebro opens with all ASINs pre-loaded

### Pattern 5: Export-Focused Workflow (VERIFIED WORKING)

When data extraction is the goal:

1. Manually or via automation get to results page
2. Wait for data to load (check for table rows)
3. Click "Export Data..." button to open dropdown
4. Click "...as a CSV file" text element
5. File downloads to ~/Downloads as `US_AMAZON_cerebro_<ASIN>_<date>.csv`

**Key Insight**: The export dropdown items are text elements, not buttons. Must click directly on the text.

```javascript
// Working export automation (verified Jan 2026)
// Step 1: Click Export Data button
const exportBtn = Array.from(document.querySelectorAll('button'))
  .find(b => b.textContent.includes('Export Data'));
if (exportBtn) exportBtn.click();

// Step 2: Wait briefly for dropdown
await new Promise(r => setTimeout(r, 500));

// Step 3: Click CSV option (text element)
const csvOption = Array.from(document.querySelectorAll('*'))
  .find(el => el.innerText && el.innerText.trim() === '...as a CSV file');
if (csvOption) csvOption.click();

// File downloads to ~/Downloads/US_AMAZON_cerebro_<ASIN>_<date>.csv
```

### Pattern 6: Multi-ASIN Cerebro Search (VERIFIED WORKING)

For researching all keywords across your product portfolio:

1. Navigate to Cerebro: `https://members.helium10.com/cerebro`
2. Use JavaScript injection to set multiple ASINs:

```javascript
// Multi-ASIN injection for Cerebro (verified Jan 2026)
const asins = ['B0BKH9QVT3', 'B0GCBJY63Y', 'B0849MFNY8']; // up to 10
const input = document.querySelector('input[placeholder*="ASIN"]')
  || document.querySelector('[class*="combobox"] input');

// Focus and clear
input.focus();
input.value = '';

// Set value with proper React event dispatching
const nativeSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype, 'value'
).set;
nativeSetter.call(input, asins.join(' '));
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));

// Submit with Enter key
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
```

**Then click "Get Keywords" button** - the input doesn't auto-submit.

## Selectors Reference

**Note**: Selectors may change with UI updates. Verify before use.

### Cerebro
```javascript
// Input field (various possible selectors)
'input[placeholder*="ASIN"]'
'input[placeholder*="Enter"]'
'.cerebro-search input'

// Get Keywords button
'button:contains("Get Keywords")'
'[data-testid="get-keywords"]'

// Export button
'button:contains("Export")'
'.export-button'

// Results table
'.keyword-results table'
'table.results-table'
```

### Black Box
```javascript
// Category dropdown
'[data-testid="category-select"]'

// Search button
'button:contains("Search")'

// Results
'.product-results'
```

## Waiting Strategies

### Wait for Element
```javascript
function waitForSelector(selector, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeout) return reject(new Error('Timeout'));
      setTimeout(check, 500);
    };
    check();
  });
}
```

### Wait for Loading
```javascript
// Wait for spinner to disappear
function waitForLoading() {
  return new Promise(resolve => {
    const check = () => {
      const spinner = document.querySelector('.loading, .spinner, [class*="loading"]');
      if (!spinner || spinner.offsetParent === null) return resolve();
      setTimeout(check, 500);
    };
    check();
  });
}
```

## Rate Limiting

- Cerebro: 2-250 searches/day depending on plan
- Add delays between operations (2-5 seconds minimum)
- Monitor for rate limit warnings
- Spread bulk operations across time

## Error Handling

### Common Errors
| Error | Cause | Solution |
|-------|-------|----------|
| "No keywords found" | Invalid/new ASIN | Verify ASIN exists |
| Session timeout | Inactivity | Re-authenticate |
| "Upgrade required" | Plan limit reached | Check plan limits |
| Results not loading | Network/timeout | Retry with longer wait |

### Recovery Pattern
```javascript
async function runWithRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.log(`Attempt ${i + 1} failed:`, e.message);
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
```

## Third-Party Automation Tools

### Axiom.ai
Browser automation tool with Helium 10 templates:
- Pre-built Cerebro automation
- CSV import/export integration
- Google Sheets sync

### General RPA Considerations
- Use existing login session (avoid automating login)
- Implement robust waits (not just sleep)
- Handle dynamic element IDs
- Export data as files rather than scraping UI
- Respect rate limits and ToS

## Best Practices

1. **Batch operations** - Use multi-ASIN when possible (up to 10)
2. **Export over scrape** - Download CSVs instead of parsing UI
3. **Verify selectors** - UI changes frequently, update selectors
4. **Add delays** - Minimum 2-3 seconds between actions
5. **Handle errors gracefully** - Implement retry logic
6. **Use Chrome Extension path** - Often more reliable than web app
7. **Monitor limits** - Track daily usage against plan limits
