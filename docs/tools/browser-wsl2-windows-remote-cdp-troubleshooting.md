

## Recovery after toggling `hypervisorlaunchtype` (Windows gaming mode)

If you temporarily disable Hyper-V with `bcdedit /set hypervisorlaunchtype off` and later re-enable it with `bcdedit /set hypervisorlaunchtype auto`, WSL2 and the Windows CDP bridge can come back in a partially broken state after reboot.

A common symptom pattern:

- `curl http://127.0.0.1:9222/json/version` works on Windows
- but from WSL2, `curl http://WINDOWS_HOST_IP:9222/json/version` times out
- OpenClaw reports remote CDP unreachable or shows zero tabs

Recommended recovery sequence (PowerShell as Administrator):

```powershell
Get-Service iphlpsvc
Start-Service iphlpsvc

# Replace OLD_HOST_IP with your previous listen address if needed
netsh interface portproxy delete v4tov4 listenaddress=OLD_HOST_IP listenport=9222
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 connectaddress=127.0.0.1 connectport=9222
netsh advfirewall firewall add rule name="Chrome CDP 9222 inbound" dir=in action=allow protocol=TCP localport=9222
```

Then validate both endpoints:

```powershell
curl.exe http://127.0.0.1:9222/json/version
curl.exe http://WINDOWS_HOST_IP:9222/json/version
```

For `WINDOWS_HOST_IP`, use the Windows host address visible from WSL2 (often the `nameserver` value in `/etc/resolv.conf`).

Once both checks return JSON, retry:

```bash
openclaw gateway restart
openclaw browser tabs --browser-profile remote
```
