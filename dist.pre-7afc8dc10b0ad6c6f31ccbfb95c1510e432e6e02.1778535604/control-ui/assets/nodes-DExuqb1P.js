import{T as I,U as g,t as r,f as a,A as v,k as w,V as h,W as $}from"./index-x9C_NheI.js";function k(...e){const s=new Set;for(const t of e){if(!t)continue;if(Array.isArray(t)){for(const l of t){const n=l.trim();n&&s.add(n)}continue}const i=t.trim();i&&s.add(i)}return[...s].toSorted()}function S(e,s){const t=new Set(e);return s.every(i=>t.has(i))}function R(e){return{roles:k(e.roles,e.role),scopes:I(e.scopes)}}function L(e){const s=k(e.roles,e.role),t=Array.isArray(e.tokens)?e.tokens:e.tokens?Object.values(e.tokens):void 0;return{roles:t===void 0?s:k(t.filter(l=>!l.revokedAtMs).flatMap(l=>l.role??[])).filter(l=>s.includes(l)),scopes:I(e.scopes)}}function T(e,s){const t=R(e),i=s?L(s):null;return i?S(i.roles,t.roles)?S(i.scopes,t.scopes)?{kind:"re-approval",requested:t,approved:i}:{kind:"scope-upgrade",requested:t,approved:i}:{kind:"role-upgrade",requested:t,approved:i}:{kind:"new-pairing",requested:t,approved:null}}function P(e){const s=e?.agents??{},t=Array.isArray(s.list)?s.list:[],i=[];return t.forEach((l,n)=>{if(!l||typeof l!="object")return;const o=l,d=g(o.id)??"";if(!d)return;const p=g(o.name),u=o.default===!0;i.push({id:d,name:p,isDefault:u,index:n,record:o})}),i}function B(e,s){const t=new Set(s),i=[];for(const l of e){if(!(Array.isArray(l.commands)?l.commands:[]).some(u=>t.has(String(u))))continue;const d=g(l.nodeId)??"";if(!d)continue;const p=g(l.displayName)??d;i.push({id:d,label:p===d?d:`${p} · ${d}`})}return i.sort((l,n)=>l.label.localeCompare(n.label)),i}const f="__defaults__",D=[{value:"deny",label:"Deny"},{value:"allowlist",label:"Allowlist"},{value:"full",label:"Full"}],F=[{value:"off",label:"Off"},{value:"on-miss",label:"On miss"},{value:"always",label:"Always"}];function N(e){return e==="allowlist"||e==="full"||e==="deny"?e:"deny"}function C(e){return e==="always"||e==="off"||e==="on-miss"?e:"on-miss"}function M(e){const s=e?.defaults??{};return{security:N(s.security),ask:C(s.ask),askFallback:N(s.askFallback??"deny"),autoAllowSkills:s.autoAllowSkills??!1}}function U(e){return P(e).map(s=>({id:s.id,name:s.name,isDefault:s.isDefault}))}function j(e,s){const t=U(e),i=Object.keys(s?.agents??{}),l=new Map;t.forEach(o=>l.set(o.id,o)),i.forEach(o=>{l.has(o)||l.set(o,{id:o})});const n=Array.from(l.values());return n.length===0&&n.push({id:"main",isDefault:!0}),n.sort((o,d)=>{if(o.isDefault&&!d.isDefault)return-1;if(!o.isDefault&&d.isDefault)return 1;const p=o.name?.trim()?o.name:o.id,u=d.name?.trim()?d.name:d.id;return p.localeCompare(u)}),n}function O(e,s){return e===f?f:e&&s.some(t=>t.id===e)?e:f}function V(e){const s=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,t=!!s,i=M(s),l=j(e.configForm,s),n=Y(e.nodes),o=e.execApprovalsTarget;let d=o==="node"&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;o==="node"&&d&&!n.some(y=>y.id===d)&&(d=null);const p=O(e.execApprovalsSelectedAgent,l),u=p!==f?(s?.agents??{})[p]??null:null,b=Array.isArray(u?.allowlist)?u.allowlist??[]:[];return{ready:t,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:s,defaults:i,selectedScope:p,selectedAgent:u,agents:l,allowlist:b,target:o,targetNodeId:d,targetNodes:n,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function z(e){const s=e.ready,t=e.target!=="node"||!!e.targetNodeId;return a`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Exec approvals</div>
          <div class="card-sub">
            Allowlist and approval policy for <span class="mono">exec host=gateway/node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.dirty||!t}
          @click=${e.onSave}
        >
          ${e.saving?"Saving…":"Save"}
        </button>
      </div>

      ${K(e)}
      ${s?a`
            ${H(e)} ${G(e)}
            ${e.selectedScope===f?v:W(e)}
          `:a`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${e.loading||!t} @click=${e.onLoad}>
              ${e.loading?r("common.loading"):r("common.loadApprovals")}
            </button>
          </div>`}
    </section>
  `}function K(e){const s=e.targetNodes.length>0,t=e.targetNodeId??"";return a`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Target</div>
          <div class="list-sub">Gateway edits local approvals; node edits the selected node.</div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Host</span>
            <select
              ?disabled=${e.disabled}
              @change=${i=>{if(i.target.value==="node"){const o=e.targetNodes[0]?.id??null;e.onSelectTarget("node",t||o)}else e.onSelectTarget("gateway",null)}}
            >
              <option value="gateway" ?selected=${e.target==="gateway"}>Gateway</option>
              <option value="node" ?selected=${e.target==="node"}>Node</option>
            </select>
          </label>
          ${e.target==="node"?a`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${e.disabled||!s}
                    @change=${i=>{const n=i.target.value.trim();e.onSelectTarget("node",n||null)}}
                  >
                    <option value="" ?selected=${t===""}>Select node</option>
                    ${e.targetNodes.map(i=>a`<option value=${i.id} ?selected=${t===i.id}>
                          ${i.label}
                        </option>`)}
                  </select>
                </label>
              `:v}
        </div>
      </div>
      ${e.target==="node"&&!s?a` <div class="muted">No nodes advertise exec approvals yet.</div> `:v}
    </div>
  `}function H(e){return a`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${e.selectedScope===f?"active":""}"
          @click=${()=>e.onSelectScope(f)}
        >
          Defaults
        </button>
        ${e.agents.map(s=>{const t=s.name?.trim()?`${s.name} (${s.id})`:s.id;return a`
            <button
              class="btn btn--sm ${e.selectedScope===s.id?"active":""}"
              @click=${()=>e.onSelectScope(s.id)}
            >
              ${t}
            </button>
          `})}
      </div>
    </div>
  `}function G(e){const s=e.selectedScope===f,t=e.defaults,i=e.selectedAgent??{},l=s?["defaults"]:["agents",e.selectedScope],n=typeof i.security=="string"?i.security:void 0,o=typeof i.ask=="string"?i.ask:void 0,d=typeof i.askFallback=="string"?i.askFallback:void 0,p=s?t.security:n??"__default__",u=s?t.ask:o??"__default__",b=s?t.askFallback:d??"__default__",y=typeof i.autoAllowSkills=="boolean"?i.autoAllowSkills:void 0,x=y??t.autoAllowSkills,_=y==null;return a`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${s?"Default security mode.":`Default: ${t.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${c=>{const m=c.target.value;!s&&m==="__default__"?e.onRemove([...l,"security"]):e.onPatch([...l,"security"],m)}}
            >
              ${s?v:a`<option value="__default__" ?selected=${p==="__default__"}>
                    Use default (${t.security})
                  </option>`}
              ${D.map(c=>a`<option value=${c.value} ?selected=${p===c.value}>
                    ${c.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${s?"Default prompt policy.":`Default: ${t.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${c=>{const m=c.target.value;!s&&m==="__default__"?e.onRemove([...l,"ask"]):e.onPatch([...l,"ask"],m)}}
            >
              ${s?v:a`<option value="__default__" ?selected=${u==="__default__"}>
                    Use default (${t.ask})
                  </option>`}
              ${F.map(c=>a`<option value=${c.value} ?selected=${u===c.value}>
                    ${c.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${s?"Applied when the UI prompt is unavailable.":`Default: ${t.askFallback}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${e.disabled}
              @change=${c=>{const m=c.target.value;!s&&m==="__default__"?e.onRemove([...l,"askFallback"]):e.onPatch([...l,"askFallback"],m)}}
            >
              ${s?v:a`<option value="__default__" ?selected=${b==="__default__"}>
                    Use default (${t.askFallback})
                  </option>`}
              ${D.map(c=>a`<option value=${c.value} ?selected=${b===c.value}>
                    ${c.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${s?"Allow skill executables listed by the Gateway.":_?`Using default (${t.autoAllowSkills?"on":"off"}).`:`Override (${x?"on":"off"}).`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${e.disabled}
              .checked=${x}
              @change=${c=>{const A=c.target;e.onPatch([...l,"autoAllowSkills"],A.checked)}}
            />
          </label>
          ${!s&&!_?a`<button
                class="btn btn--sm"
                ?disabled=${e.disabled}
                @click=${()=>e.onRemove([...l,"autoAllowSkills"])}
              >
                Use default
              </button>`:v}
        </div>
      </div>
    </div>
  `}function W(e){const s=["agents",e.selectedScope,"allowlist"],t=e.allowlist;return a`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${e.disabled}
        @click=${()=>{const i=[...t,{pattern:""}];e.onPatch(s,i)}}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${t.length===0?a` <div class="muted">No allowlist entries yet.</div> `:t.map((i,l)=>X(e,i,l))}
    </div>
  `}function X(e,s,t){const i=s.lastUsedAt?w(s.lastUsedAt):"never",l=s.lastUsedCommand?h(s.lastUsedCommand,120):null,n=s.lastResolvedPath?h(s.lastResolvedPath,120):null;return a`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${s.pattern?.trim()?s.pattern:"New pattern"}</div>
        <div class="list-sub">Last used: ${i}</div>
        ${l?a`<div class="list-sub mono">${l}</div>`:v}
        ${n?a`<div class="list-sub mono">${n}</div>`:v}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${s.pattern??""}
            ?disabled=${e.disabled}
            @input=${o=>{const d=o.target;e.onPatch(["agents",e.selectedScope,"allowlist",t,"pattern"],d.value)}}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${e.disabled}
          @click=${()=>{if(e.allowlist.length<=1){e.onRemove(["agents",e.selectedScope,"allowlist"]);return}e.onRemove(["agents",e.selectedScope,"allowlist",t])}}
        >
          Remove
        </button>
      </div>
    </div>
  `}function Y(e){return B(e,["system.execApprovals.get","system.execApprovals.set"])}function ce(e){const s=te(e),t=V(e);return a`
    ${z(t)} ${ie(s)} ${J(e)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?r("common.loading"):r("common.refresh")}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${e.nodes.length===0?a` <div class="muted">No nodes found.</div> `:e.nodes.map(i=>oe(i))}
      </div>
    </section>
  `}function J(e){const s=e.devicesList??{pending:[],paired:[]},t=Array.isArray(s.pending)?s.pending:[],i=Array.isArray(s.paired)?s.paired:[],l=new Map(i.map(n=>[g(n.deviceId),n]).filter(n=>!!n[0]));return a`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${e.devicesLoading} @click=${e.onDevicesRefresh}>
          ${e.devicesLoading?r("common.loading"):r("common.refresh")}
        </button>
      </div>
      ${e.devicesError?a`<div class="callout danger" style="margin-top: 12px;">${e.devicesError}</div>`:v}
      <div class="list" style="margin-top: 16px;">
        ${t.length>0?a`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${t.map(n=>q(n,e,Q(l,n)))}
            `:v}
        ${i.length>0?a`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${i.map(n=>ee(n,e))}
            `:v}
        ${t.length===0&&i.length===0?a` <div class="muted">No paired devices.</div> `:v}
      </div>
    </section>
  `}function Q(e,s){const t=g(s.deviceId);if(!t)return;const i=e.get(t);if(!i)return;const l=g(s.publicKey),n=g(i.publicKey);if(!(l&&n&&l!==n))return i}function E(e){return e?`roles: ${$(e.roles)} · scopes: ${$(e.scopes)}`:"none"}function Z(e){switch(e){case"scope-upgrade":return"scope upgrade requires approval";case"role-upgrade":return"role upgrade requires approval";case"re-approval":return"reconnect details changed; approval required";case"new-pairing":return"new device pairing request"}throw new Error("unsupported pending approval kind")}function q(e,s,t){const i=g(e.displayName)||e.deviceId,l=typeof e.ts=="number"?w(e.ts):r("common.na"),n=T(e,t),o=e.isRepair?" · repair":"",d=e.remoteIp?` · ${e.remoteIp}`:"";return a`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">${e.deviceId}${d}</div>
        <div class="muted" style="margin-top: 6px;">
          ${Z(n.kind)} · requested ${l}${o}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${E(n.requested)}
        </div>
        ${n.approved?a`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${E(n.approved)}
              </div>
            `:v}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${()=>s.onDeviceApprove(e.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${()=>s.onDeviceReject(e.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `}function ee(e,s){const t=g(e.displayName)||e.deviceId,i=e.remoteIp?` · ${e.remoteIp}`:"",l=`roles: ${$(e.roles)}`,n=`scopes: ${$(e.scopes)}`,o=Array.isArray(e.tokens)?e.tokens:[];return a`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${t}</div>
        <div class="list-sub">${e.deviceId}${i}</div>
        <div class="muted" style="margin-top: 6px;">${l} · ${n}</div>
        ${o.length===0?a` <div class="muted" style="margin-top: 6px">Tokens: none</div> `:a`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${o.map(d=>se(e.deviceId,d,s))}
              </div>
            `}
      </div>
    </div>
  `}function se(e,s,t){const i=s.revokedAtMs?"revoked":"active",l=`scopes: ${$(s.scopes)}`,n=w(s.rotatedAtMs??s.createdAtMs??s.lastUsedAtMs??null);return a`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${s.role} · ${i} · ${l} · ${n}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>t.onDeviceRotate(e,s.role,s.scopes)}
        >
          Rotate
        </button>
        ${s.revokedAtMs?v:a`
              <button
                class="btn btn--sm danger"
                @click=${()=>t.onDeviceRevoke(e,s.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}function te(e){const s=e.configForm,t=ne(e.nodes),{defaultBinding:i,agents:l}=ae(s),n=!!s,o=e.configSaving||e.configFormMode==="raw";return{ready:n,disabled:o,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:i,agents:l,nodes:t,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function ie(e){const s=e.nodes.length>0,t=e.defaultBinding??"";return a`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${r("nodes.binding.execNodeBinding")}</div>
          <div class="card-sub">${r("nodes.binding.execNodeBindingSubtitle")}</div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.configDirty}
          @click=${e.onSave}
        >
          ${e.configSaving?r("common.saving"):r("common.save")}
        </button>
      </div>

      ${e.formMode==="raw"?a`
            <div class="callout warn" style="margin-top: 12px">
              ${r("nodes.binding.formModeHint")}
            </div>
          `:v}
      ${e.ready?a`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${r("nodes.binding.defaultBinding")}</div>
                  <div class="list-sub">${r("nodes.binding.defaultBindingHint")}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${r("nodes.binding.node")}</span>
                    <select
                      ?disabled=${e.disabled||!s}
                      @change=${i=>{const n=i.target.value.trim();e.onBindDefault(n||null)}}
                    >
                      <option value="" ?selected=${t===""}>Any node</option>
                      ${e.nodes.map(i=>a`<option value=${i.id} ?selected=${t===i.id}>
                            ${i.label}
                          </option>`)}
                    </select>
                  </label>
                  ${s?v:a` <div class="muted">No nodes with system.run available.</div> `}
                </div>
              </div>

              ${e.agents.length===0?a` <div class="muted">No agents found.</div> `:e.agents.map(i=>le(i,e))}
            </div>
          `:a`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${r("nodes.binding.loadConfigHint")}</div>
            <button class="btn" ?disabled=${e.configLoading} @click=${e.onLoadConfig}>
              ${e.configLoading?r("common.loading"):r("common.loadConfig")}
            </button>
          </div>`}
    </section>
  `}function le(e,s){const t=e.binding??"__default__",i=e.name?.trim()?`${e.name} (${e.id})`:e.id,l=s.nodes.length>0;return a`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">
          ${e.isDefault?"default agent":"agent"} ·
          ${t==="__default__"?`uses default (${s.defaultBinding??"any"})`:`override: ${e.binding}`}
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${s.disabled||!l}
            @change=${n=>{const d=n.target.value.trim();s.onBindAgent(e.index,d==="__default__"?null:d)}}
          >
            <option value="__default__" ?selected=${t==="__default__"}>
              Use default
            </option>
            ${s.nodes.map(n=>a`<option value=${n.id} ?selected=${t===n.id}>
                  ${n.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function ne(e){return B(e,["system.run"])}function ae(e){const s={id:"main",name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!="object")return{defaultBinding:null,agents:[s]};const i=(e.tools??{}).exec??{},l=typeof i.node=="string"&&i.node.trim()?i.node.trim():null,n=e.agents??{};if(!Array.isArray(n.list)||n.list.length===0)return{defaultBinding:l,agents:[s]};const o=P(e).map(d=>{const u=(d.record.tools??{}).exec??{},b=typeof u.node=="string"&&u.node.trim()?u.node.trim():null;return{id:d.id,name:d.name,index:d.index,isDefault:d.isDefault,binding:b}});return o.length===0&&o.push(s),{defaultBinding:l,agents:o}}function oe(e){const s=!!e.connected,t=!!e.paired,i=typeof e.displayName=="string"&&e.displayName.trim()||(typeof e.nodeId=="string"?e.nodeId:"unknown"),l=Array.isArray(e.caps)?e.caps:[],n=Array.isArray(e.commands)?e.commands:[];return a`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">
          ${typeof e.nodeId=="string"?e.nodeId:""}
          ${typeof e.remoteIp=="string"?` · ${e.remoteIp}`:""}
          ${typeof e.version=="string"?` · ${e.version}`:""}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${t?"paired":"unpaired"}</span>
          <span class="chip ${s?"chip-ok":"chip-warn"}">
            ${s?"connected":"offline"}
          </span>
          ${l.slice(0,12).map(o=>a`<span class="chip">${String(o)}</span>`)}
          ${n.slice(0,8).map(o=>a`<span class="chip">${String(o)}</span>`)}
        </div>
      </div>
    </div>
  `}export{ce as renderNodes};
//# sourceMappingURL=nodes-DExuqb1P.js.map
