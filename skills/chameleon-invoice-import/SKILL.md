# Chameleon Collective Invoice Processor

**Purpose**: Automatically process Chameleon Collective invoice emails and create corresponding QuickBooks invoices for JHS Digital Consulting LLC.

## Trigger

Process emails matching:

- **From**: `noreply-app@collective-os.com`
- **Subject**: Contains `Invoice: XXXXX`
- **To**: `john.schneider@chameleon.co`

## What This Skill Does

1. **Extracts** payout data from Chameleon Collective invoice confirmation emails
2. **Checks** if an invoice with this number already exists in QuickBooks
   - If duplicate found: sends abort notification email and stops processing
3. **Classifies** the invoice type:
   - **Scenario A**: John has a primary consulting/referral section → creates invoice with Op Fee
   - **Scenario B**: Commission-only from other consultants → creates invoice with just commissions
4. **Calculates** the appropriate Chameleon Collective Op Fee:
   - **8%** for Consulting work
   - **20%** for Solution Partner Referral work
5. **Creates** a properly formatted QuickBooks invoice with:
   - All relevant line items (consulting, commissions)
   - Negative Op Fee line
   - Correct client name in memo
   - Net 30 payment terms
6. **Sends confirmation email** to john.schneider@chameleon.co with:
   - Invoice summary
   - Link to view invoice in QuickBooks Online

## QuickBooks Invoice Structure

**Bill To**: Chameleon Collective, 2093 Philadelphia Pike, #8440, Claymont, DE 19703

**Invoice Components**:

- John's primary work (if applicable): Consulting or Solution Partner Referral
- John's commissions on his own work (Originating, Closing)
- Chameleon Collective Op Fee (negative amount, calculated on John's section only)
- Commissions from other consultants' sections

**Memo**: Client name from email header

## Key Business Rules

1. **Check for duplicate invoices** before creating - abort if invoice number already exists
2. **Op Fee is calculated ONLY on John's primary section** (not on commissions from others)
3. **Skip $0.00 line items** and items where John is not the recipient
4. **Use the invoice number from the email** as the QuickBooks invoice number
5. **Due date is Invoice Date + 30 days** (not the due date from the email)
6. **Commission percentages** vary by project (5%, 7.5%, etc.) - extract from email

## Email Notifications

**Duplicate Invoice Detected**:

- **To**: john.schneider@chameleon.co
- **Subject**: Duplicate Invoice Detected: [Invoice Number]
- **Body**: Summarize the invoice details and note that processing was aborted due to existing invoice

**Invoice Created Successfully**:

- **To**: john.schneider@chameleon.co
- **Subject**: QuickBooks Invoice Created: [Invoice Number]
- **Body**:
  - Invoice summary (client, amount, line items)
  - Direct link to view invoice in QuickBooks Online
  - Invoice date and due date

## Detailed Documentation

For complete transformation rules, worked examples, and API implementation details, see:

**[references/process-new-invoice.md](references/process-new-invoice.md)**

That document includes:

- 6 worked examples covering all scenarios
- Detailed line-by-line transformation rules
- QuickBooks API implementation notes
- Error handling guidelines
- Validation checklist
