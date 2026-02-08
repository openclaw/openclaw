---
summary: "Plan: tüm mesajlaşma bağlayıcıları için tek, temiz bir eklenti SDK'sı + çalışma zamanı"
read_when:
  - Eklenti mimarisini tanımlarken veya yeniden düzenlerken
  - Kanal bağlayıcılarını eklenti SDK'sı/çalışma zamanına taşırken
title: "Eklenti SDK'sı Yeniden Düzenleme"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:47Z
---

# Eklenti SDK'sı + Çalışma Zamanı Yeniden Düzenleme Planı

Amaç: her mesajlaşma bağlayıcısının, tek ve kararlı bir API kullanan bir eklenti (paketli veya harici) olması.
Hiçbir eklenti doğrudan `src/**` içe aktarmasın. Tüm bağımlılıklar SDK veya çalışma zamanı üzerinden geçsin.

## Neden şimdi

- Mevcut bağlayıcılar desenleri karıştırıyor: doğrudan çekirdek içe aktarımları, yalnızca dağıtıma özel köprüler ve özel yardımcılar.
- Bu durum yükseltmeleri kırılgan hale getiriyor ve temiz bir harici eklenti yüzeyini engelliyor.

## Hedef mimari (iki katman)

### 1) Eklenti SDK'sı (derleme zamanı, kararlı, yayımlanabilir)

Kapsam: türler, yardımcılar ve yapılandırma yardımcıları. Çalışma zamanı durumu yok, yan etki yok.

İçerik (örnekler):

- Türler: `ChannelPlugin`, bağdaştırıcılar, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Yapılandırma yardımcıları: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Eşleştirme yardımcıları: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding yardımcıları: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding türleri.
- Araç parametre yardımcıları: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Doküman bağlantı yardımcısı: `formatDocsLink`.

Dağıtım:

- `openclaw/plugin-sdk` olarak yayımlansın (veya çekirdekten `openclaw/plugin-sdk` altında dışa aktarılsın).
- Açık kararlılık garantileriyle semver.

### 2) Eklenti Çalışma Zamanı (yürütme yüzeyi, enjekte edilen)

Kapsam: çekirdek çalışma zamanı davranışına dokunan her şey.
Eklentiler `src/**` içe aktarmasın diye `OpenClawPluginApi.runtime` üzerinden erişilir.

Önerilen yüzey (minimal ama eksiksiz):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

Notlar:

- Çekirdek davranışına erişmenin tek yolu çalışma zamanıdır.
- SDK bilinçli olarak küçük ve kararlıdır.
- Her çalışma zamanı yöntemi mevcut bir çekirdek uygulamasına eşlenir (çoğaltma yok).

## Geçiş planı (aşamalı, güvenli)

### Aşama 0: iskele oluşturma

- `openclaw/plugin-sdk` tanıtılsın.
- Yukarıdaki yüzeyle `OpenClawPluginApi` içine `api.runtime` eklensin.
- Geçiş penceresi boyunca mevcut içe aktarımlar korunsun (kullanımdan kaldırma uyarıları).

### Aşama 1: köprü temizliği (düşük risk)

- Uzantı başına `core-bridge.ts` yerine `api.runtime` kullanılsın.
- Önce BlueBubbles, Zalo, Zalo Personal taşınsın (zaten yakınlar).
- Yinelenen köprü kodu kaldırılsın.

### Aşama 2: hafif doğrudan içe aktarımlı eklentiler

- Matrix, SDK + çalışma zamanına taşınsın.
- Onboarding, dizin ve grup bahsetme mantığı doğrulansın.

### Aşama 3: ağır doğrudan içe aktarımlı eklentiler

- MS Teams taşınsın (en büyük çalışma zamanı yardımcıları seti).
- Yanıt/yazıyor semantiğinin mevcut davranışla eşleştiğinden emin olun.

### Aşama 4: iMessage eklentileştirme

- iMessage, `extensions/imessage` içine taşınsın.
- Doğrudan çekirdek çağrıları `api.runtime` ile değiştirilsin.
- Yapılandırma anahtarları, CLI davranışı ve dokümanlar korunarak kalsın.

### Aşama 5: zorunlu kılma

- Lint kuralı / CI denetimi eklensin: `src/**` içinden `extensions/**` içe aktarımları yok.
- Eklenti SDK/sürüm uyumluluk denetimleri eklensin (çalışma zamanı + SDK semver).

## Uyumluluk ve sürümleme

- SDK: semver, yayımlanmış, değişiklikleri belgelenmiş.
- Çalışma zamanı: çekirdek sürüm başına sürümlenir. `api.runtime.version` eklensin.
- Eklentiler gerekli çalışma zamanı aralığını bildirir (örn. `openclawRuntime: ">=2026.2.0"`).

## Test stratejisi

- Bağdaştırıcı düzeyinde birim testleri (çalışma zamanı işlevleri gerçek çekirdek uygulamasıyla çalıştırılır).
- Eklenti başına golden testler: davranış kayması olmadığından emin olun (yönlendirme, eşleştirme, izin listesi, mention gating).
- CI'da kullanılan tek bir uçtan uca eklenti örneği (kurulum + çalıştırma + smoke).

## Açık sorular

- SDK türleri nerede barındırılmalı: ayrı paket mi yoksa çekirdek dışa aktarımı mı?
- Çalışma zamanı türlerinin dağıtımı: SDK'da mı (yalnızca türler) yoksa çekirdekte mi?
- Paketli ve harici eklentiler için doküman bağlantıları nasıl sunulmalı?
- Geçiş sırasında depo içi eklentiler için sınırlı doğrudan çekirdek içe aktarımlarına izin veriyor muyuz?

## Başarı ölçütleri

- Tüm kanal bağlayıcıları SDK + çalışma zamanı kullanan eklentilerdir.
- `src/**` içinden `extensions/**` içe aktarımları yoktur.
- Yeni bağlayıcı şablonları yalnızca SDK + çalışma zamanına bağımlıdır.
- Harici eklentiler, çekirdek kaynak koduna erişim olmadan geliştirilebilir ve güncellenebilir.

İlgili dokümanlar: [Eklentiler](/tools/plugin), [Kanallar](/channels/index), [Yapılandırma](/gateway/configuration).
