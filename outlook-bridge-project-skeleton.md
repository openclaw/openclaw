# .NET Tabanlı Outlook Bridge Proje İskeleti

Bu doküman, Outlook otomasyonu için önerilen local bridge servisini .NET tabanlı olarak nasıl başlatabileceğini gösteren pratik bir iskelet sunar. Amaç production-ready kod vermek değil; doğru sınırlarla başlayacak bir temel oluşturmaktır.

---

## 1. Teknoloji Seçimi

Öneri:

- **ASP.NET Core Minimal API**
- **Microsoft Graph SDK**
- İleride secret storage için uygun provider
- Logging için built-in `ILogger`

Neden Minimal API?

- küçük servis için yeterli
- hızlı PoC çıkar
- endpoint’ler net kalır
- sonra kolay büyür

---

## 2. Önerilen Çözüm Yapısı

```text
OutlookBridge.sln
src/
  OutlookBridge.Api/
    OutlookBridge.Api.csproj
    Program.cs
    appsettings.json
    appsettings.Development.json
    Endpoints/
      HealthEndpoints.cs
      ProfileEndpoints.cs
      MailEndpoints.cs
      CalendarEndpoints.cs
    Services/
      IGraphAuthService.cs
      GraphAuthService.cs
      IMailService.cs
      GraphMailService.cs
      ICalendarService.cs
      GraphCalendarService.cs
    Models/
      MeDto.cs
      InboxSummaryDto.cs
      MessageListItemDto.cs
      MessageDetailDto.cs
      CalendarEventDto.cs
      DraftReplyRequest.cs
    Options/
      GraphOptions.cs
    Security/
      OperationPolicy.cs
    Utils/
      HtmlSanitizer.cs
      TextTruncator.cs
tests/
  OutlookBridge.Api.Tests/
docs/
  setup.md
  api.md
```

---

## 3. Başlangıç Paketleri

Örnek NuGet paketleri:

```bash
dotnet add package Microsoft.Graph
dotnet add package Azure.Identity
dotnet add package Microsoft.Extensions.Http
dotnet add package FluentValidation
```

Not:
Gerçek auth akışına göre ek paket gerekebilir.

---

## 4. appsettings Örneği

```json
{
  "Graph": {
    "TenantId": "YOUR_TENANT_ID",
    "ClientId": "YOUR_CLIENT_ID",
    "ClientSecret": "USE_SECRET_STORE_NOT_PLAIN_TEXT",
    "Scopes": ["User.Read", "Mail.Read", "Calendars.Read"]
  },
  "Bridge": {
    "AllowDraftCreation": false,
    "AllowSendMail": false,
    "MaxMessageBodyChars": 4000
  },
  "Kestrel": {
    "Endpoints": {
      "Http": {
        "Url": "http://127.0.0.1:5077"
      }
    }
  }
}
```

Üretimde `ClientSecret` düz metin tutulmamalı.

---

## 5. Program.cs İskeleti

```csharp
using Microsoft.Extensions.Options;
using OutlookBridge.Api.Options;
using OutlookBridge.Api.Security;
using OutlookBridge.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<GraphOptions>(builder.Configuration.GetSection("Graph"));
builder.Services.AddSingleton<OperationPolicy>();
builder.Services.AddSingleton<IGraphAuthService, GraphAuthService>();
builder.Services.AddSingleton<IMailService, GraphMailService>();
builder.Services.AddSingleton<ICalendarService, GraphCalendarService>();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddProblemDetails();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { ok = true, service = "outlook-bridge" }));

app.MapGet("/me", async (IGraphAuthService authService) =>
{
    var me = await authService.GetCurrentUserAsync();
    return Results.Ok(me);
});

app.MapGet("/mail/messages", async (
    string? from,
    bool unreadOnly,
    int top,
    IMailService mailService) =>
{
    var result = await mailService.ListMessagesAsync(from, unreadOnly, top);
    return Results.Ok(result);
});

app.MapGet("/mail/inbox-summary", async (
    int hours,
    bool unreadOnly,
    int top,
    IMailService mailService) =>
{
    var result = await mailService.GetInboxSummaryAsync(hours, unreadOnly, top);
    return Results.Ok(result);
});

app.MapGet("/calendar/upcoming", async (int hours, ICalendarService calendarService) =>
{
    var result = await calendarService.GetUpcomingEventsAsync(hours);
    return Results.Ok(result);
});

app.Run();
```

Bu yalnızca yön gösterici bir iskelet.

---

## 6. GraphOptions Sınıfı

```csharp
namespace OutlookBridge.Api.Options;

public sealed class GraphOptions
{
    public string TenantId { get; set; } = string.Empty;
    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;
    public string[] Scopes { get; set; } = Array.Empty<string>();
}
```

---

## 7. OperationPolicy Sınıfı

```csharp
namespace OutlookBridge.Api.Security;

public sealed class OperationPolicy
{
    public bool AllowReadInbox => true;
    public bool AllowReadCalendar => true;
    public bool AllowDraftCreation => false;
    public bool AllowSendMail => false;
    public bool AllowDeleteMail => false;
}
```

Bu katman küçük görünür ama önemli. İleride config tabanlı hale getirilebilir.

---

## 8. Mail Service Arayüzü

```csharp
using OutlookBridge.Api.Models;

namespace OutlookBridge.Api.Services;

public interface IMailService
{
    Task<IReadOnlyList<MessageListItemDto>> ListMessagesAsync(string? from, bool unreadOnly, int top);
    Task<InboxSummaryDto> GetInboxSummaryAsync(int hours, bool unreadOnly, int top);
    Task<MessageDetailDto?> GetMessageAsync(string id);
}
```

---

## 9. DTO Örnekleri

### MessageListItemDto

```csharp
namespace OutlookBridge.Api.Models;

public sealed class MessageListItemDto
{
    public string Id { get; set; } = string.Empty;
    public string Subject { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
    public DateTimeOffset ReceivedAt { get; set; }
    public bool IsRead { get; set; }
    public string Snippet { get; set; } = string.Empty;
}
```

### InboxSummaryDto

```csharp
namespace OutlookBridge.Api.Models;

public sealed class InboxSummaryDto
{
    public int TotalCount { get; set; }
    public int UnreadCount { get; set; }
    public IReadOnlyList<MessageListItemDto> Messages { get; set; } = Array.Empty<MessageListItemDto>();
}
```

---

## 10. GraphMailService İçin Yönlendirici Pseudocode

```csharp
public sealed class GraphMailService : IMailService
{
    public async Task<IReadOnlyList<MessageListItemDto>> ListMessagesAsync(string? from, bool unreadOnly, int top)
    {
        // 1. Graph client oluştur
        // 2. Inbox query hazırla
        // 3. from / unread filtrelerini uygula
        // 4. Sonuçları DTO'ya map et
        // 5. Body preview sanitize et
        // 6. Döndür
        throw new NotImplementedException();
    }

    public async Task<InboxSummaryDto> GetInboxSummaryAsync(int hours, bool unreadOnly, int top)
    {
        // Zaman filtresi + unread filtresi ile liste çek
        // Toplam ve unread sayılarını hesapla
        // Kısa özet DTO'su dön
        throw new NotImplementedException();
    }

    public async Task<MessageDetailDto?> GetMessageAsync(string id)
    {
        // Tekil mesajı al
        // Gerekirse HTML temizle
        // Güvenli detay DTO'su dön
        throw new NotImplementedException();
    }
}
```

---

## 11. Auth Katmanı için Yaklaşım

Auth tarafı iki şekilde tasarlanabilir:

### A. Uygulama adına erişim değil, kullanıcı delegasyonu

Bu senaryoda daha doğru olan çoğu zaman budur.

Avantaj:

- kullanıcı mailbox’ı için doğal model
- least privilege uygulanabilir

### B. Service principal / application permission

Daha güçlüdür ama fazla yetkili olabilir.

**Tavsiye:**
İlk sürümde mümkünse **delegated auth** ile git.

---

## 12. Endpoint Genişletme Sırası

Uygulama sırası şu olsun:

1. `/health`
2. `/me`
3. `/mail/messages`
4. `/mail/messages/{id}`
5. `/mail/inbox-summary`
6. `/calendar/upcoming`
7. `/mail/draft-reply`

Bu sıra debug etmeyi kolaylaştırır.

---

## 13. Logging Önerisi

Her istekte en az şu alanları logla:

- request id
- endpoint
- elapsed ms
- result count
- error code

Ama bunları loglama:

- token
- tam HTML body
- hassas header’lar

---

## 14. Güvenlik Notları

- Servis yalnızca `127.0.0.1` üstünde dinlesin
- Swagger açılacaksa sadece development ortamında açılsın
- Draft/send endpoint’leri feature flag ile korunsun
- Input validation zorunlu olsun

---

## 15. İlk PoC İçin Minimum Tamamlanmış Tanım

Bir ilk PoC başarılı sayılırsa şunlar çalışıyor olmalı:

- servis ayağa kalkıyor
- Graph auth başarılı
- `/me` kullanıcıyı döndürüyor
- `/mail/messages` inbox’tan sonuç döndürüyor
- `/calendar/upcoming` toplantıları listeliyor
- sonuçlar Ceviz tarafından özetlenebiliyor

---

## 16. Sonraki Adım

Bu iskeletten sonra en mantıklı devam adımı:

- gerçek klasör/query davranışını netleştirmek
- auth akışını seçmek
- sonra doğrudan çalışan bir PoC üretmek

Yani buradan sonra istersen bir sonraki adımda sana şunu da hazırlayabilirim:

1. **Azure App Registration kurulum rehberi**
2. **çalışan örnek Minimal API başlangıç kodu**
3. **OpenClaw/Ceviz entegrasyon katmanı taslağı**
