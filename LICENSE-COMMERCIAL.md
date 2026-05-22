# ClaWorks Commercial Licensing

## Open Source Components

The following components are released under the **MIT License** (see [LICENSE](LICENSE)):

| Component              | Package / Path                                     |
| ---------------------- | -------------------------------------------------- |
| ClaWorks Runtime       | `packages/claworks-runtime/` → `@claworks/runtime` |
| ClaWorks Pack SDK      | `packages/claworks-sdk/` → `@claworks/sdk`         |
| OpenClaw plugin bridge | `extensions/claworks-robot/`                       |
| OpenClaw core          | `src/**` (upstream MIT, © Peter Steinberger)       |

You are free to use, modify, and redistribute these components under MIT terms, including for commercial products, without purchasing a license.

---

## Commercial Components

The following are **not** included in this repository and require a separate commercial agreement:

### Industry Packs

Industry Packs are domain-specific bundles of ObjectTypes, Playbooks, and curated ontology data for verticals such as oil & gas, manufacturing, and logistics.

- Distributed via **ClaWorks Nexus** (the pack registry).
- Each pack carries its own license file (`LICENSE` inside the pack archive).
- Evaluation licenses available for qualified enterprise customers.

Typical pack structure:

```
oil-gas-pack-1.0.0.cwpack
├── pack.json             (metadata + license declaration)
├── LICENSE               (commercial terms)
└── ontology/
    ├── types/            (domain ObjectType definitions)
    └── playbooks/        (pre-built automation Playbooks)
```

### Enterprise Features

Enterprise add-ons (sold separately or bundled with ClaWorks Cloud):

| Feature              | Description                                           |
| -------------------- | ----------------------------------------------------- |
| **Multi-tenancy**    | Isolated namespaces for multiple tenants on one robot |
| **SSO / SAML**       | Enterprise identity provider integration              |
| **Audit log export** | Tamper-evident event export to SIEM                   |
| **SLA monitoring**   | Playbook SLA breach detection and escalation          |
| **Advanced RBAC**    | Row-level security, delegation chains                 |

### ClaWorks Cloud (SaaS)

Fully managed ClaWorks hosting. Contact [hi@claworks.ai](mailto:hi@claworks.ai).

---

## FAQ

**Can I build a commercial product using `@claworks/runtime`?**  
Yes. MIT license allows commercial use without restriction.

**Can I redistribute Industry Packs I purchased?**  
No. Industry Pack licenses are seat- or deployment-based. See the specific pack's `LICENSE` file.

**Can I create and sell my own packs?**  
Yes — packs you author are your intellectual property. You choose the license. The SDK (`@claworks/sdk`) is MIT.

**How do I get an evaluation license for an Industry Pack?**  
Email [hi@claworks.ai](mailto:hi@claworks.ai) or visit [claworks.ai/packs](https://claworks.ai/packs).
