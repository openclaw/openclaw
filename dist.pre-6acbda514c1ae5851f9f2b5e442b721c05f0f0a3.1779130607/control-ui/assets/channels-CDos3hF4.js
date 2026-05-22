import{O as e,X as t,Y as n,c as r,et as i,k as a,l as o,nt as s,rt as c}from"./index-CoVeaHEU.js";import{n as l,t as u}from"./channel-config-extras-BXnnHOUg.js";function d(e,n){let r=e;for(let e of n){if(!r)return null;let n=t(r);if(n===`object`){let t=r.properties??{};if(typeof e==`string`&&t[e]){r=t[e];continue}let n=r.additionalProperties;if(typeof e==`string`&&n&&typeof n==`object`){r=n;continue}return null}if(n===`array`){if(typeof e!=`number`)return null;r=(Array.isArray(r.items)?r.items[0]:r.items)??null;continue}return null}return r}function f(e,t){return l(e,t)??{}}var p=[`groupPolicy`,`streamMode`,`dmPolicy`];function m(e){let t=p.flatMap(t=>t in e?[[t,e[t]]]:[]);return t.length===0?null:c`
    <div class="status-list" style="margin-top: 12px;">
      ${t.map(([e,t])=>c`
          <div>
            <span class="label">${e}</span>
            <span>${u(t)}</span>
          </div>
        `)}
    </div>
  `}function h(e){let t=r(e.schema),n=t.schema;if(!n)return c` <div class="callout danger">Schema unavailable. Use Raw.</div> `;let i=d(n,[`channels`,e.channelId]);if(!i)return c` <div class="callout danger">Channel config schema unavailable.</div> `;let a=f(e.configValue??{},e.channelId);return c`
    <div class="config-form">
      ${o({schema:i,value:a,path:[`channels`,e.channelId],hints:e.uiHints,unsupported:new Set(t.unsupportedPaths),disabled:e.disabled,showLabel:!1,onPatch:e.onPatch})}
    </div>
    ${m(a)}
  `}function g(e){let{channelId:t,props:n}=e,r=n.configSaving||n.configSchemaLoading;return c`
    <div style="margin-top: 16px;">
      ${n.configSchemaLoading?c` <div class="muted">Loading config schema…</div> `:h({channelId:t,configValue:n.configForm,schema:n.configSchema,uiHints:n.configUiHints,disabled:r,onPatch:n.onConfigPatch})}
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${r||!n.configFormDirty}
          @click=${()=>n.onConfigSave()}
        >
          ${n.configSaving?`Saving…`:`Save`}
        </button>
        <button class="btn" ?disabled=${r} @click=${()=>n.onConfigReload()}>
          ${i(`common.reload`)}
        </button>
      </div>
    </div>
  `}function _(e,t){return t.snapshot?.channels?.[e]}function v(e,t){let n=t.snapshot?.channelAccounts?.[e]??[],r=t.snapshot?.channelDefaultAccountId?.[e];return(r?n.find(e=>e.accountId===r):void 0)??n[0]??null}function y(e,t){let n=_(e,t),r=t.snapshot?.channelAccounts?.[e]??[],i=v(e,t);return{configured:typeof n?.configured==`boolean`?n.configured:typeof i?.configured==`boolean`?i.configured:null,running:typeof n?.running==`boolean`?n.running:null,connected:typeof n?.connected==`boolean`?n.connected:null,defaultAccount:i,hasAnyActiveAccount:r.some(e=>e.configured||e.running||e.connected),status:n}}function b(e,t){if(!t.snapshot)return!1;let n=y(e,t);return n.configured===!0||n.running===!0||n.connected===!0||n.hasAnyActiveAccount}function x(e,t){return y(e,t).configured}function S(e){return i(e==null?`common.na`:e?`common.yes`:`common.no`)}function C(e){return c`
    <div class="card">
      <div class="card-title">${e.title}</div>
      <div class="card-sub">${e.subtitle}</div>
      ${e.accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        ${e.statusRows.map(e=>c`
            <div>
              <span class="label">${e.label}</span>
              <span>${e.value}</span>
            </div>
          `)}
      </div>

      ${e.lastError?c`<div class="callout danger" style="margin-top: 12px;">${e.lastError}</div>`:s}
      ${e.secondaryCallout??s} ${e.extraContent??s}
      ${e.configSection} ${e.footer??s}
    </div>
  `}function w(e,t){return t?.[e]?.length??0}function T(e,t){let n=w(e,t);return n<2?s:c`<div class="account-count">Accounts (${n})</div>`}function E(t){let{props:n,discord:r,accountCountLabel:a}=t,o=x(`discord`,n);return C({title:`Discord`,subtitle:`Bot status and channel configuration.`,accountCountLabel:a,statusRows:[{label:i(`common.configured`),value:S(o)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.status??``} ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`discord`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function D(t){let{props:n,googleChat:r,accountCountLabel:a}=t,o=x(`googlechat`,n);return C({title:`Google Chat`,subtitle:`Chat API webhook status and channel configuration.`,accountCountLabel:a,statusRows:[{label:i(`common.configured`),value:S(o)},{label:i(`common.running`),value:r?r.running?i(`common.yes`):i(`common.no`):i(`common.na`)},{label:i(`common.credential`),value:r?.credentialSource??i(`common.na`)},{label:i(`common.audience`),value:r?.audienceType?`${r.audienceType}${r.audience?` · ${r.audience}`:``}`:i(`common.na`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.status??``} ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`googlechat`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function O(t){let{props:n,imessage:r,accountCountLabel:a}=t,o=x(`imessage`,n);return C({title:`iMessage`,subtitle:`macOS bridge status and channel configuration.`,accountCountLabel:a,statusRows:[{label:i(`common.configured`),value:S(o)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`imessage`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function k(e){return e?e.length<=20?e:`${e.slice(0,8)}...${e.slice(-8)}`:i(`common.na`)}function A(t){let{props:r,nostr:a,nostrAccounts:o,accountCountLabel:l,profileFormState:u,profileFormCallbacks:d,onEditProfile:f}=t,p=o[0],m=a?.configured??p?.configured??!1,h=a?.running??p?.running??!1,_=a?.publicKey??p?.publicKey,v=a?.lastStartAt??p?.lastStartAt??null,y=a?.lastError??p?.lastError??null,b=o.length>1,x=u!=null,S=t=>{let n=t.publicKey,r=t.profile;return c`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${r?.displayName??r?.name??t.name??t.accountId}</div>
          <div class="account-card-id">${t.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${i(`common.running`)}</span>
            <span>${t.running?i(`common.yes`):i(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${i(`common.configured`)}</span>
            <span>${t.configured?i(`common.yes`):i(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${i(`common.publicKey`)}</span>
            <span class="monospace" title="${n??``}">${k(n)}</span>
          </div>
          <div>
            <span class="label">${i(`common.lastInbound`)}</span>
            <span
              >${t.lastInboundAt?e(t.lastInboundAt):i(`common.na`)}</span
            >
          </div>
          ${t.lastError?c` <div class="account-card-error">${t.lastError}</div> `:s}
        </div>
      </div>
    `};return c`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Decentralized DMs via Nostr relays (NIP-04).</div>
      ${l}
      ${b?c`
            <div class="account-card-list">
              ${o.map(e=>S(e))}
            </div>
          `:c`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${i(`common.configured`)}</span>
                <span>${i(m?`common.yes`:`common.no`)}</span>
              </div>
              <div>
                <span class="label">${i(`common.running`)}</span>
                <span>${i(h?`common.yes`:`common.no`)}</span>
              </div>
              <div>
                <span class="label">${i(`common.publicKey`)}</span>
                <span class="monospace" title="${_??``}"
                  >${k(_)}</span
                >
              </div>
              <div>
                <span class="label">${i(`common.lastStart`)}</span>
                <span>
                  ${v?e(v):i(`common.na`)}
                </span>
              </div>
            </div>
          `}
      ${y?c`<div class="callout danger" style="margin-top: 12px;">${y}</div>`:s}
      ${(()=>{if(x&&d)return n({state:u,callbacks:d,accountId:o[0]?.accountId??`default`});let{name:e,displayName:t,about:r,picture:l,nip05:h}=p?.profile??a?.profile??{},g=e||t||r||l||h;return c`
      <div
        style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-md);"
      >
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"
        >
          <div style="font-weight: 500;">${i(`channels.nostr.profile`)}</div>
          ${m?c`
                <button
                  class="btn btn--sm"
                  @click=${f}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  ${i(`channels.nostr.editProfile`)}
                </button>
              `:s}
        </div>
        ${g?c`
              <div class="status-list">
                ${l?c`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${l}
                          alt=${i(`channels.nostr.profilePicture`)}
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${e=>{e.target.style.display=`none`}}
                        />
                      </div>
                    `:s}
                ${e?c`<div>
                      <span class="label">${i(`channels.nostr.name`)}</span><span>${e}</span>
                    </div>`:s}
                ${t?c`<div>
                      <span class="label">${i(`channels.nostr.displayName`)}</span
                      ><span>${t}</span>
                    </div>`:s}
                ${r?c`<div>
                      <span class="label">${i(`channels.nostr.about`)}</span
                      ><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;"
                        >${r}</span
                      >
                    </div>`:s}
                ${h?c`<div><span class="label">NIP-05</span><span>${h}</span></div>`:s}
              </div>
            `:c`
              <div style="color: var(--text-muted); font-size: 13px">
                ${i(`channels.nostr.noProfile`)} ${i(`channels.nostr.noProfileHint`)}
              </div>
            `}
      </div>
    `})()} ${g({channelId:`nostr`,props:r})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>r.onRefresh(!1)}>${i(`common.refresh`)}</button>
      </div>
    </div>
  `}function j(t){let{props:n,signal:r,accountCountLabel:a}=t,o=x(`signal`,n);return C({title:`Signal`,subtitle:`signal-cli status and channel configuration.`,accountCountLabel:a,statusRows:[{label:i(`common.configured`),value:S(o)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.baseUrl`),value:r?.baseUrl??i(`common.na`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.status??``} ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`signal`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function M(t){let{props:n,slack:r,accountCountLabel:a}=t,o=x(`slack`,n);return C({title:`Slack`,subtitle:`Socket mode status and channel configuration.`,accountCountLabel:a,statusRows:[{label:i(`common.configured`),value:S(o)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.status??``} ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`slack`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function N(t){let{props:n,telegram:r,telegramAccounts:a,accountCountLabel:o}=t,l=a.length>1,u=x(`telegram`,n),d=t=>{let n=t.probe?.bot?.username,r=t.name||t.accountId;return c`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${n?`@${n}`:r}</div>
          <div class="account-card-id">${t.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${i(`common.running`)}</span>
            <span>${t.running?i(`common.yes`):i(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${i(`common.configured`)}</span>
            <span>${t.configured?i(`common.yes`):i(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${i(`common.lastInbound`)}</span>
            <span
              >${t.lastInboundAt?e(t.lastInboundAt):i(`common.na`)}</span
            >
          </div>
          ${t.lastError?c` <div class="account-card-error">${t.lastError}</div> `:s}
        </div>
      </div>
    `};return l?c`
      <div class="card">
        <div class="card-title">Telegram</div>
        <div class="card-sub">Bot status and channel configuration.</div>
        ${o}

        <div class="account-card-list">
          ${a.map(e=>d(e))}
        </div>

        ${r?.lastError?c`<div class="callout danger" style="margin-top: 12px;">${r.lastError}</div>`:s}
        ${r?.probe?c`<div class="callout" style="margin-top: 12px;">
              ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
              ${r.probe.status??``} ${r.probe.error??``}
            </div>`:s}
        ${g({channelId:`telegram`,props:n})}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
        </div>
      </div>
    `:C({title:`Telegram`,subtitle:`Bot status and channel configuration.`,accountCountLabel:o,statusRows:[{label:i(`common.configured`),value:S(u)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.mode`),value:r?.mode??i(`common.na`)},{label:i(`common.lastStart`),value:r?.lastStartAt?e(r.lastStartAt):i(`common.na`)},{label:i(`common.lastProbe`),value:r?.lastProbeAt?e(r.lastProbeAt):i(`common.na`)}],lastError:r?.lastError,secondaryCallout:r?.probe?c`<div class="callout" style="margin-top: 12px;">
          ${r.probe.ok?i(`common.probeOk`):i(`common.probeFailed`)} ·
          ${r.probe.status??``} ${r.probe.error??``}
        </div>`:s,configSection:g({channelId:`telegram`,props:n}),footer:c`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.probe`)}</button>
    </div>`})}function P(t){let{props:n,whatsapp:r,accountCountLabel:o}=t,l=x(`whatsapp`,n),u=r?.linked===!0,d=n.whatsappQrDataUrl!=null;return C({title:`WhatsApp`,subtitle:`Link WhatsApp Web and monitor connection health.`,accountCountLabel:o,statusRows:[{label:i(`common.configured`),value:S(l)},{label:i(`common.linked`),value:r?.linked?i(`common.yes`):i(`common.no`)},{label:i(`common.running`),value:r?.running?i(`common.yes`):i(`common.no`)},{label:i(`common.connected`),value:r?.connected?i(`common.yes`):i(`common.no`)},{label:i(`common.lastConnect`),value:r?.lastConnectedAt?e(r.lastConnectedAt):i(`common.na`)},{label:i(`common.lastMessage`),value:r?.lastMessageAt?e(r.lastMessageAt):i(`common.na`)},{label:i(`common.authAge`),value:r?.authAgeMs==null?i(`common.na`):a(r.authAgeMs)}],lastError:r?.lastError,extraContent:c`
      ${n.whatsappMessage?c`<div class="callout" style="margin-top: 12px;">${n.whatsappMessage}</div>`:s}
      ${n.whatsappQrDataUrl?c`<div class="qr-wrap">
            <img src=${n.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`:s}
    `,configSection:g({channelId:`whatsapp`,props:n}),footer:c`<div class="row" style="margin-top: 14px; flex-wrap: wrap;">
      ${u?c`<button
            class="btn"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppStart(!0)}
          >
            ${i(`common.relink`)}
          </button>`:c`<button
            class="btn primary"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppStart(!1)}
          >
            ${n.whatsappBusy?i(`common.working`):i(`common.showQr`)}
          </button>`}
      ${d?c`<button
            class="btn"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppWait()}
          >
            ${i(`common.waitForScan`)}
          </button>`:s}
      <button
        class="btn danger"
        ?disabled=${n.whatsappBusy}
        @click=${()=>n.onWhatsAppLogout()}
      >
        ${i(`common.logout`)}
      </button>
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${i(`common.refresh`)}</button>
    </div>`})}function F(t){let n=t.snapshot?.channels,r=n?.whatsapp??void 0,a=n?.telegram??void 0,o=n?.discord??null,l=n?.googlechat??null,u=n?.slack??null,d=n?.signal??null,f=n?.imessage??null,p=n?.nostr??null,m=I(t.snapshot).map((e,n)=>({key:e,enabled:b(e,t),order:n})).toSorted((e,t)=>e.enabled===t.enabled?e.order-t.order:e.enabled?-1:1),h=!!(t.loading&&t.snapshot&&t.lastSuccessAt),g=t.snapshot?.warnings?.filter(e=>e.trim())??[];return c`
    <section class="grid grid-cols-2">
      ${m.map(e=>L(e.key,t,{whatsapp:r,telegram:a,discord:o,googlechat:l,slack:u,signal:d,imessage:f,nostr:p,channelAccounts:t.snapshot?.channelAccounts??null}))}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${i(`channels.health.title`)}</div>
          <div class="card-sub">${i(`channels.health.subtitle`)}</div>
        </div>
        <div class="muted">
          ${t.lastSuccessAt?e(t.lastSuccessAt):i(`common.na`)}
        </div>
      </div>
      ${h?c`
            <div class="callout info" style="margin-top: 12px;">
              Refreshing channel status in the background; showing the last successful snapshot.
            </div>
          `:s}
      ${t.snapshot?.partial?c`
            <div class="callout warn" style="margin-top: 12px;">
              Some channel checks did not finish before the UI budget.
              ${g.length>0?g.slice(0,3).join(`; `):``}
            </div>
          `:s}
      ${t.lastError?c`<div class="callout danger" style="margin-top: 12px;">${t.lastError}</div>`:s}
      <pre class="code-block" style="margin-top: 12px;">
${t.snapshot?JSON.stringify(t.snapshot,null,2):i(`channels.health.noSnapshotYet`)}
      </pre
      >
    </section>
  `}function I(e){return e?.channelMeta?.length?e.channelMeta.map(e=>e.id):e?.channelOrder?.length?e.channelOrder:[`whatsapp`,`telegram`,`discord`,`googlechat`,`slack`,`signal`,`imessage`,`nostr`]}function L(e,t,n){let r=T(e,n.channelAccounts);switch(e){case`whatsapp`:return P({props:t,whatsapp:n.whatsapp,accountCountLabel:r});case`telegram`:return N({props:t,telegram:n.telegram,telegramAccounts:n.channelAccounts?.telegram??[],accountCountLabel:r});case`discord`:return E({props:t,discord:n.discord,accountCountLabel:r});case`googlechat`:return D({props:t,googleChat:n.googlechat,accountCountLabel:r});case`slack`:return M({props:t,slack:n.slack,accountCountLabel:r});case`signal`:return j({props:t,signal:n.signal,accountCountLabel:r});case`imessage`:return O({props:t,imessage:n.imessage,accountCountLabel:r});case`nostr`:{let e=n.channelAccounts?.nostr??[],i=e[0],a=i?.accountId??`default`,o=i?.profile??null,s=t.nostrProfileAccountId===a?t.nostrProfileFormState:null,c=s?{onFieldChange:t.onNostrProfileFieldChange,onSave:t.onNostrProfileSave,onImport:t.onNostrProfileImport,onCancel:t.onNostrProfileCancel,onToggleAdvanced:t.onNostrProfileToggleAdvanced}:null;return A({props:t,nostr:n.nostr,nostrAccounts:e,accountCountLabel:r,profileFormState:s,profileFormCallbacks:c,onEditProfile:()=>t.onNostrProfileEdit(a,o)})}default:return R(e,t,n.channelAccounts??{})}}function R(e,t,n){let r=B(t.snapshot,e),a=y(e,t),o=typeof a.status?.lastError==`string`?a.status.lastError:void 0,l=n[e]??[],u=T(e,n);return c`
    <div class="card">
      <div class="card-title">${r}</div>
      <div class="card-sub">${i(`channels.generic.subtitle`)}</div>
      ${u}
      ${l.length>0?c`
            <div class="account-card-list">
              ${l.map(e=>G(e))}
            </div>
          `:c`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${i(`common.configured`)}</span>
                <span>${S(a.configured)}</span>
              </div>
              <div>
                <span class="label">${i(`common.running`)}</span>
                <span>${S(a.running)}</span>
              </div>
              <div>
                <span class="label">${i(`common.connected`)}</span>
                <span>${S(a.connected)}</span>
              </div>
            </div>
          `}
      ${o?c`<div class="callout danger" style="margin-top: 12px;">${o}</div>`:s}
      ${g({channelId:e,props:t})}
    </div>
  `}function z(e){return e?.channelMeta?.length?Object.fromEntries(e.channelMeta.map(e=>[e.id,e])):{}}function B(e,t){return z(e)[t]?.label??e?.channelLabels?.[t]??t}var V=600*1e3;function H(e){return e.lastInboundAt?Date.now()-e.lastInboundAt<V:!1}function U(e){return e.running?i(`common.yes`):H(e)?i(`common.active`):i(`common.no`)}function W(e){return e.connected===!0?i(`common.yes`):e.connected===!1?i(`common.no`):H(e)?i(`common.active`):i(`common.na`)}function G(t){let n=U(t),r=W(t);return c`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${t.name||t.accountId}</div>
        <div class="account-card-id">${t.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">${i(`common.running`)}</span>
          <span>${n}</span>
        </div>
        <div>
          <span class="label">${i(`common.configured`)}</span>
          <span>${t.configured?i(`common.yes`):i(`common.no`)}</span>
        </div>
        <div>
          <span class="label">${i(`common.connected`)}</span>
          <span>${r}</span>
        </div>
        <div>
          <span class="label">${i(`common.lastInbound`)}</span>
          <span
            >${t.lastInboundAt?e(t.lastInboundAt):i(`common.na`)}</span
          >
        </div>
        ${t.lastError?c` <div class="account-card-error">${t.lastError}</div> `:s}
      </div>
    </div>
  `}export{F as renderChannels};
//# sourceMappingURL=channels-CDos3hF4.js.map