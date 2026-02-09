---
summary: "OpenClaw üzerinden cihaz akışını kullanarak GitHub Copilot'a giriş yapın"
read_when:
  - GitHub Copilot'ı bir model sağlayıcı olarak kullanmak istiyorsunuz
  - "`openclaw models auth login-github-copilot` akışına ihtiyacınız var"
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot nedir?

GitHub Copilot, GitHub’un yapay zekâ destekli kodlama asistanıdır. GitHub hesabınız ve planınız için Copilot modellerine erişim sağlar. OpenClaw, Copilot’ı bir model sağlayıcı olarak iki farklı şekilde kullanabilir.

## OpenClaw’da Copilot’ı kullanmanın iki yolu

### 1. Yerleşik GitHub Copilot sağlayıcısı (`github-copilot`)

Yerel cihazla oturum açma akışını kullanarak bir GitHub belirteci alın, ardından OpenClaw çalıştığında bunu Copilot API belirteçleriyle değiştirin. VS Code gerektirmediği için bu **varsayılan** ve en basit yoldur.

### 2. Copilot Proxy eklentisi (`copilot-proxy`)

Yerel bir köprü olarak **Copilot Proxy** VS Code uzantısını kullanın. OpenClaw, proxy’nin `/v1` uç noktasına bağlanır ve orada yapılandırdığınız model listesini kullanır. VS Code’da Copilot Proxy’yi zaten çalıştırıyorsanız veya trafiği onun üzerinden yönlendirmeniz gerekiyorsa bunu seçin.
Eklentiyi etkinleştirmeniz ve VS Code uzantısını çalışır durumda tutmanız gerekir.

GitHub Copilot’ı bir model sağlayıcı olarak kullanın (`github-copilot`). Oturum açma komutu GitHub cihaz akışını çalıştırır, bir kimlik doğrulama profili kaydeder ve yapılandırmanızı bu profili kullanacak şekilde günceller.

## CLI kurulumu

```bash
openclaw models auth login-github-copilot
```

Bir URL’yi ziyaret etmeniz ve tek kullanımlık bir kod girmeniz istenecektir. İşlem tamamlanana kadar terminali açık tutun.

### İsteğe bağlı bayraklar

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Varsayılan bir model ayarlama

```bash
openclaw models set github-copilot/gpt-4o
```

### Yapılandırma parçacığı

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notlar

- Etkileşimli bir TTY gerektirir; doğrudan bir terminalde çalıştırın.
- Copilot model kullanılabilirliği planınıza bağlıdır; bir model reddedilirse başka bir kimliği deneyin (örneğin `github-copilot/gpt-4.1`).
- Oturum açma işlemi, GitHub belirtecini kimlik doğrulama profil deposunda saklar ve OpenClaw çalıştığında bunu bir Copilot API belirteciyle değiştirir.
