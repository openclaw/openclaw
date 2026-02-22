# Pre-Redact — To-Do List

> Pinned: Feb 21, 2026

---

## 🔴 Priority Gaps to Close

- [ ] **Un-redaction step** — Show the "magic moment" where the AI's output gets fully restored with original PII. Side-by-side redacted → restored view. Biggest missing UX moment.
- [ ] **Audit Log Entry UI** — Data exists. Needs the 3-level disclosure UI wrapper:
  - Level 1: `✅ Verified` badge in audit row (95% of users)
  - Level 2: "View Record" flyout (Verification ID + Copy + Open Immutable Record link)
  - Level 3: ICP explorer link for auditors
- [ ] **Redaction Receipt PDF** — Downloadable one-pager after each session. Enterprise trust artifact. Wraps existing audit data. QR code → verify link. Never says "blockchain" or "canister."
- [ ] **Team Shared Templates** — Org-level templates shared across team members (vs. personal templates only).
- [ ] **Team Dashboard** — Shell: Usage stats, Team Members, Audit Log, API Keys, Storage (OfficeX Drive). Links into OfficeX work suite.

---

## ✅ Already Have (just needs showcasing)

- Identity / Auth
- Audit trail (backend)
- Billing (in progress)
- API (covered via HTTPS Gateway — users don't need to think about it)

---

## 💡 Design Principles to Keep

- **Crypto = invisible.** Never say hash/blockchain/canister/ICP in user-facing UI.
- **Language:** "Verification ID" not "hash" · "Tamper-proof record" not "on-chain" · "Permanently recorded" not "blockchain"
- **Progressive disclosure:** Show trust status first, show details only on click.
- **Receipt PDF** is the enterprise compliance artifact — file it, share it, audit it.

---

## 🏗 Integration: Pre-Redact ↔ OfficeX

- Pre-Redact = AI privacy gateway for the OfficeX work suite
- Redaction maps + audit records store in user-owned OfficeX Drive canisters
- Team Dashboard bridges Pre-Redact sessions → OfficeX org identity
- Pitch: _"The AI never sees your PII — and neither do we."_

---

## Flow (Target State)

```
Upload → Detect → Redact → AI Chat → UN-REDACT → Export
                                          ↓             ↓
                                   Full doc restored  Save to OfficeX Drive
                                                          ↓
                                                  Audit log entry + Receipt PDF
```
