---
name: tesco-order
description: Order groceries from Tesco online
metadata:
  requires:
    tools: ["browser", "vault"]
  approval: "confirm_with_screenshot"
  agent: "browser"
---

# Tesco Grocery Order

## Goal
Order groceries from Tesco.com using a saved basket or user-provided shopping list.

## Steps

### Step 1: Login
- Navigate to tesco.com
- Use vault credentials for "tesco" to login
- If 2FA is triggered, screenshot the prompt and notify user via Telegram

### Step 2: Load Basket
- If user says "usual order" or "saved basket": load the saved basket
- If user provides a shopping list: search and add each item
- For each item, prefer the item the user has previously purchased

### Step 3: Review Substitutions
- Check if any items are unavailable
- If unavailable, suggest a substitution and ask the user
- Wait for user confirmation before proceeding

### Step 4: Select Delivery Slot
- Select an evening slot (6pm-9pm) per USER.md preferences
- If no evening slot available:
  - Screenshot available slots
  - Send to user via Telegram
  - Wait for user selection

### Step 5: Checkout
- Screenshot the full order summary including total price
- Send screenshot to user via Telegram with inline buttons:
  - [Confirm Order] [Cancel] [Modify]
- Wait for user approval

### Step 6: Confirm
- On approval, click "Place Order"
- Screenshot the confirmation page
- Send confirmation to user

## Edge Cases
- If session expires during order, re-login and resume from last step
- If price has changed >20% from last order, flag before checkout
- If Tesco site is down, notify user and suggest retry time
- Never proceed past checkout without explicit user approval
