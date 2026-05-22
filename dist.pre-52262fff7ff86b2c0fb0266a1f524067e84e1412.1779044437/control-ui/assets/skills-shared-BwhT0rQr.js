import{nt as e,rt as t}from"./index-DSJDdoGg.js";var n=[{id:`workspace`,label:`Workspace Skills`,sources:[`openclaw-workspace`]},{id:`built-in`,label:`Built-in Skills`,sources:[`openclaw-bundled`]},{id:`installed`,label:`Installed Skills`,sources:[`openclaw-managed`]},{id:`extra`,label:`Extra Skills`,sources:[`openclaw-extra`]}];function r(e){let t=new Map;for(let e of n)t.set(e.id,{id:e.id,label:e.label,skills:[]});let r=n.find(e=>e.id===`built-in`),i={id:`other`,label:`Other Skills`,skills:[]};for(let a of e){let e=a.bundled?r:n.find(e=>e.sources.includes(a.source));e?t.get(e.id)?.skills.push(a):i.skills.push(a)}let a=n.map(e=>t.get(e.id)).filter(e=>!!(e&&e.skills.length>0));return i.skills.length>0&&a.push(i),a}function i(e){return[...e.missing.bins.map(e=>`bin:${e}`),...e.missing.env.map(e=>`env:${e}`),...e.missing.config.map(e=>`config:${e}`),...e.missing.os.map(e=>`os:${e}`)]}function a(e){let t=[];return e.disabled&&t.push(`disabled`),e.blockedByAllowlist&&t.push(`blocked by allowlist`),t}function o(n){let r=n.skill,i=!!n.showBundledBadge;return t`
    <div class="chip-row" style="margin-top: 6px;">
      <span class="chip">${r.source}</span>
      ${i?t` <span class="chip">bundled</span> `:e}
      <span class="chip ${r.eligible?`chip-ok`:`chip-warn`}">
        ${r.eligible?`eligible`:`blocked`}
      </span>
      ${r.disabled?t` <span class="chip chip-warn">disabled</span> `:e}
    </div>
  `}export{r as i,a as n,o as r,i as t};
//# sourceMappingURL=skills-shared-BwhT0rQr.js.map