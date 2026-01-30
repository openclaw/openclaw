# Context Discovery

> Before suggesting any architecture, gather context.

## Question Hierarchy (Ask User FIRST)

1. **Scale**
   - How many users? (10, 1K, 100K, 1M+)
   - Data volume? (MB, GB, TB)
   - Transaction rate? (per second/minute)

2. **Team**
   - Solo developer or team?
   - Team size and expertise?
   - Distributed or co-located?

3. **Timeline**
   - MVP/Prototype or long-term product?
   - Time to market pressure?

4. **Domain**
   - CRUD-heavy or business logic complex?
   - Real-time requirements?
   - Compliance/regulations?

5. **Constraints**
   - Budget limitations?
   - Legacy systems to integrate?
   - Technology stack preferences?

## Project Classification Matrix

```
                    MVP              SaaS           Enterprise
┌─────────────────────────────────────────────────────────────┐
│ Scale        │ <1K           │ 1K-100K      │ 100K+        │
│ Team         │ Solo          │ 2-10         │ 10+          │
│ Timeline     │ Fast (weeks)  │ Medium (months)│ Long (years)│
│ Architecture │ Simple        │ Modular      │ Distributed  │
│ Patterns     │ Minimal       │ Selective    │ Comprehensive│
│ Example      │ Next.js API   │ NestJS       �� Microservices│
└─────────────────────────────────────────────────────────────┘
```
