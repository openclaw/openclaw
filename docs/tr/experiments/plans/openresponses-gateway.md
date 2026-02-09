---
summary: "Plan: OpenResponses /v1/responses uç noktasını eklemek ve chat completions’ı temiz bir şekilde kullanımdan kaldırmak"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway Planı"
---

# OpenResponses Gateway Entegrasyon Planı

## Context

OpenClaw Gateway şu anda
`/v1/chat/completions` adresinde minimal, OpenAI uyumlu bir Chat Completions uç noktası sunmaktadır
([OpenAI Chat Completions](/gateway/openai-http-api) bölümüne bakın).

Open Responses, OpenAI Responses API’ye dayanan açık bir çıkarım standardıdır. Ajan tabanlı iş akışları
için tasarlanmıştır ve öğe tabanlı girdiler ile anlamsal akış olaylarını kullanır. OpenResponses
spesifikasyonu `/v1/responses`’i tanımlar, `/v1/chat/completions`’yi değil.

## Hedefler

- OpenResponses semantiğine uyan bir `/v1/responses` uç noktası eklemek.
- Chat Completions’ı, devre dışı bırakılması kolay ve zamanla kaldırılabilecek bir uyumluluk katmanı olarak tutmak.
- Doğrulama ve ayrıştırmayı izole, yeniden kullanılabilir şemalarla standartlaştırmak.

## Hedef Dışı Kapsam

- İlk aşamada tam OpenResponses özellik eşliği (görseller, dosyalar, barındırılan araçlar).
- Dahili ajan yürütme mantığının veya araç orkestrasyonunun değiştirilmesi.
- İlk fazda mevcut `/v1/chat/completions` davranışının değiştirilmesi.

## Araştırma Özeti

Kaynaklar: OpenResponses OpenAPI, OpenResponses spesifikasyon sitesi ve Hugging Face blog yazısı.

Çıkarılan kilit noktalar:

- `POST /v1/responses`, `CreateResponseBody` alanlarını kabul eder; bunlar `model`, `input` (string veya
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` ve
  `max_tool_calls` gibi alanları içerir.
- `ItemParam`, aşağıdakilerin ayırt edici bir birleşimidir:
  - `message` öğeleri; roller `system`, `developer`, `user`, `assistant`
  - `function_call` ve `function_call_output`
  - `reasoning`
  - `item_reference`
- Başarılı yanıtlar, `object: "response"`, `status` ve
  `output` öğelerini içeren bir `ResponseResource` döndürür.
- Akış, aşağıdaki gibi anlamsal olayları kullanır:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Spesifikasyon şunları gerektirir:
  - `Content-Type: text/event-stream`
  - `event:`, JSON `type` alanıyla eşleşmelidir
  - terminal olayın literal olarak `[DONE]` olması gerekir
- Akıl yürütme öğeleri `content`, `encrypted_content` ve `summary`’yı açığa çıkarabilir.
- HF örnekleri, isteklerde `OpenResponses-Version: latest`’yi (isteğe bağlı başlık) içerir.

## Önerilen Mimari

- Yalnızca Zod şemalarını içeren (gateway importları olmadan) `src/gateway/open-responses.schema.ts` eklemek.
- `/v1/responses` için `src/gateway/openresponses-http.ts` (veya `open-responses-http.ts`) eklemek.
- Eski uyumluluk adaptörü olarak `src/gateway/openai-http.ts`’yi olduğu gibi tutmak.
- Yapılandırma `gateway.http.endpoints.responses.enabled` eklemek (varsayılan `false`).
- `gateway.http.endpoints.chatCompletions.enabled`’i bağımsız tutmak; her iki uç noktanın da
  ayrı ayrı açılıp kapatılabilmesine izin vermek.
- Chat Completions etkin olduğunda, eski durumunu belirtmek için başlangıçta bir uyarı yayımlamak.

## Chat Completions İçin Kullanımdan Kaldırma Yolu

- Katı modül sınırlarını korumak: responses ve chat completions arasında paylaşılan şema türleri olmamalı.
- Chat Completions’ı yapılandırma ile isteğe bağlı yapmak; böylece kod değişikliği olmadan devre dışı bırakılabilsin.
- `/v1/responses` kararlı hale geldiğinde, belgelerde Chat Completions’ı eski (legacy) olarak etiketlemek.
- İsteğe bağlı gelecekteki adım: daha basit bir kaldırma yolu için Chat Completions isteklerini Responses işleyicisine eşlemek.

## Faz 1 Destek Alt Kümesi

- `input`’yi string olarak veya mesaj rolleri ve `function_call_output` içeren `ItemParam[]` olarak kabul etmek.
- Sistem ve geliştirici mesajlarını `extraSystemPrompt` içine çıkarmak.
- Ajan çalıştırmaları için geçerli mesaj olarak en son `user` veya `function_call_output`’yi kullanmak.
- Desteklenmeyen içerik parçalarını (görsel/dosya) `invalid_request_error` ile reddetmek.
- `output_text` içeriğiyle tek bir assistant mesajı döndürmek.
- Token muhasebesi bağlanana kadar sıfırlanmış değerlerle `usage` döndürmek.

## Doğrulama Stratejisi (SDK Yok)

- Desteklenen alt küme için Zod şemaları uygulamak:
  - `CreateResponseBody`
  - `ItemParam` + mesaj içerik parçası birleşimleri
  - `ResponseResource`
  - Gateway tarafından kullanılan akış olay şekilleri
- Sapmayı önlemek ve gelecekte codegen’e izin vermek için şemaları tek, izole bir modülde tutmak.

## Akış Uygulaması (Faz 1)

- Hem `event:` hem de `data:` içeren SSE satırları.
- Gerekli sıra (asgari uygulanabilir):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (gerektikçe tekrar)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Testler ve Doğrulama Planı

- `/v1/responses` için e2e kapsaması eklemek:
  - Kimlik doğrulama gerekli
  - Akışsız yanıt şekli
  - Akış olay sıralaması ve `[DONE]`
  - Başlıklar ve `user` ile oturum yönlendirme
- `src/gateway/openai-http.e2e.test.ts`’yi değiştirmeden tutmak.
- Manuel: `stream: true` ile `/v1/responses`’e curl atmak ve olay sıralaması ile terminal
  `[DONE]`’i doğrulamak.

## Doküman Güncellemeleri (Takip)

- `/v1/responses` kullanımı ve örnekleri için yeni bir doküman sayfası eklemek.
- `/gateway/openai-http-api`’yi eski (legacy) notuyla ve `/v1/responses`’e yönlendirme ile güncellemek.
