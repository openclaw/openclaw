---
name: genpark-compare
description: "Use this skill when the user wants to compare two or more products on GenPark side-by-side — features, specs, price, reviews. Triggers: 'compare X vs Y on genpark', 'which is better on genpark', 'genpark comparison', 'help me decide between', 'X or Y — what does genpark say'. NOT for: general product research without a comparison (use genpark-shop), or reviews (use genpark-review-summarizer)."
metadata: {"openclaw": {"emoji": "⚖️", "requires": {}}}
---

# GenPark Compare — Side-by-Side Product Comparison

Compare two or more products on GenPark to help the user make a confident purchase decision. Uses browser navigation on `genpark.ai`.

## When to Use

✅ **USE this skill when:**

- "Compare Product A vs Product B on GenPark"
- "Which is better — [Laptop X] or [Laptop Y]?"
- "Help me decide between these two items on GenPark"
- User provides 2+ products and wants a ranking

❌ **DON'T use this skill when:**

- User only mentions one product → use `genpark-shop` or `genpark-review-summarizer`
- User wants general trend data → use `genpark-digest`
- Products are not on GenPark → do a general comparison instead

---

## Step 1: Confirm the Products

Identify the exact products to compare. If the user is vague (e.g., "compare two budget mechanical keyboards"), clarify:
- Exact product names or GenPark URLs
- What matters most to them: price? durability? aesthetics? reviews?

If comparing 3+ products, limit to the **best 2 finalists** for the head-to-head table.

---

## Step 2: Research Each Product Individually

For **each product**, navigate to its GenPark listing:

1. Go to `https://genpark.ai` and search for the product by name
2. Open the product page
3. Record:
   - **Price** (current listed price)
   - **Key specs / features** (bullet the top 5)
   - **Review score** and number of reviews
   - **Top-praised strength** (from reviews)
   - **Most-criticized weakness** (from reviews)
   - **GenPark's editorial tag** (e.g., "#1 in category", "Editor's Pick", "Best Value")
   - **Direct link** to the listing

---

## Step 3: Build the Comparison Table

Present a clean side-by-side table:

---

⚖️ **GenPark Comparison: [Product A] vs [Product B]**

| Feature | [Product A] | [Product B] |
|---|---|---|
| **Price** | $XX | $XX |
| **Key Spec 1** | Value | Value |
| **Key Spec 2** | Value | Value |
| **Key Spec 3** | Value | Value |
| **Review Score** | ★ X.X (N reviews) | ★ X.X (N reviews) |
| **Best For** | [use case] | [use case] |
| **Biggest Weakness** | [flaw] | [flaw] |
| **GenPark Badge** | [tag if any] | [tag if any] |
| **Link** | [View →](url) | [View →](url) |

---

## Step 4: Give a Verdict

Always end with a decisive recommendation:

> 🏆 **My Pick: [Product Name]**
>
> [2–3 sentence explanation] — specifically WHY it wins for this user's stated needs.

If it's genuinely a tie or "it depends," say that too, but give a tie-breaker criterion:

> "Both are great. Go with **A** if [X], or **B** if [Y]."

---

## Step 5: Offer Next Actions

- "Want me to dig deeper into [specific feature] for either product?"
- "Should I check if there are newer alternatives in the same category?"
- "Want me to add the winner to your GenPark wishlist?"

---

## Notes

- Use the exact product name or ASIN/ID when searching to avoid comparing different variants
- If prices differ by less than 10%, treat them as "roughly equal" and focus on specs/reviews
- If one product has far more reviews, weight its consensus more heavily in the verdict
- Avoid comparing accessories vs main products (e.g., don't compare a GPU to a laptop)
- Always link both products so the user can verify independently
