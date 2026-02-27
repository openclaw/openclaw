using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using OpenClaw.Node.Protocol;

namespace OpenClaw.Node.Services
{
    public class NodeCommandExecutor
    {
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static string ToJson(object? value) => JsonSerializer.Serialize(value, JsonOptions);

        private readonly IGatewayRpcClient? _rpc;
        private readonly IScreenImageProvider _screen;

        public NodeCommandExecutor(IGatewayRpcClient? rpc = null, IScreenImageProvider? screen = null)
        {
            _rpc = rpc;
            _screen = screen ?? new ScreenCaptureService();
        }

        public async Task<BridgeInvokeResponse> ExecuteAsync(BridgeInvokeRequest request)
        {
            try
            {
                return request.Command switch
                {
                    "system.notify" => HandleSystemNotify(request),
                    "system.which" => await HandleSystemWhichAsync(request),
                    "system.run" => await HandleSystemRunAsync(request),
                    "screen.capture" => await HandleScreenCaptureAsync(request),
                    "screen.list" => await HandleScreenListAsync(request),
                    "screen.record" => await HandleScreenRecordAsync(request),
                    "camera.list" => await HandleCameraListAsync(request),
                    "camera.snap" => await HandleCameraSnapAsync(request),
                    "window.list" => await HandleWindowListAsync(request),
                    "window.focus" => await HandleWindowFocusAsync(request),
                    "window.rect" => await HandleWindowRectAsync(request),
                    "input.type" => await HandleInputTypeAsync(request),
                    "input.key" => await HandleInputKeyAsync(request),
                    "input.click" => await HandleInputClickAsync(request),
                    "input.scroll" => await HandleInputScrollAsync(request),
                    "input.click.relative" => await HandleInputClickRelativeAsync(request),
                    "ui.find" => await HandleUiFindAsync(request),
                    "ui.click" => await HandleUiClickAsync(request),
                    "ui.type" => await HandleUiTypeAsync(request),
                    _ => new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.InvalidRequest,
                            Message = $"Unsupported command: {request.Command}"
                        }
                    }
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = ex.Message
                    }
                };
            }
        }

        private BridgeInvokeResponse HandleSystemNotify(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            var title = root?.TryGetProperty("title", out var t) == true ? t.GetString() : null;
            var body = root?.TryGetProperty("body", out var b) == true ? b.GetString() : null;

            Console.WriteLine($"[NOTIFY] {title ?? "(no title)"}: {body ?? ""}");
            return new BridgeInvokeResponse
            {
                Id = request.Id,
                Ok = true,
                PayloadJSON = ToJson(new { ok = true })
            };
        }

        private async Task<BridgeInvokeResponse> HandleSystemWhichAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            var command = root?.TryGetProperty("command", out var c) == true ? c.GetString() : null;
            if (string.IsNullOrWhiteSpace(command))
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.InvalidRequest,
                        Message = "system.which requires params.command"
                    }
                };
            }

            var whichProgram = OperatingSystem.IsWindows() ? "where" : "which";
            var result = await RunProcessAsync(whichProgram, command);

            var payload = new
            {
                ok = result.ExitCode == 0,
                found = result.ExitCode == 0,
                path = result.StdOut.Trim(),
                stderr = result.StdErr.Trim(),
            };

            return new BridgeInvokeResponse
            {
                Id = request.Id,
                Ok = result.ExitCode == 0,
                PayloadJSON = ToJson(payload),
                Error = result.ExitCode == 0
                    ? null
                    : new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = string.IsNullOrWhiteSpace(result.StdErr)
                            ? $"command not found: {command}"
                            : result.StdErr.Trim()
                    }
            };
        }

        private async Task<BridgeInvokeResponse> HandleSystemRunAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "system.run requires params");
            }

            int? timeoutMs = null;
            if (root.Value.TryGetProperty("timeoutMs", out var timeoutEl))
            {
                if (timeoutEl.ValueKind != JsonValueKind.Number || !timeoutEl.TryGetInt32(out var parsedTimeout))
                {
                    return Invalid(request.Id, "system.run params.timeoutMs must be an integer");
                }

                if (parsedTimeout <= 0)
                {
                    return Invalid(request.Id, "system.run params.timeoutMs must be > 0");
                }

                timeoutMs = parsedTimeout;
            }

            ProcessResult result;

            if (root.Value.TryGetProperty("command", out var commandEl))
            {
                if (commandEl.ValueKind == JsonValueKind.Array)
                {
                    var first = true;
                    string fileName = string.Empty;
                    var args = new System.Collections.Generic.List<string>();
                    foreach (var part in commandEl.EnumerateArray())
                    {
                        if (part.ValueKind != JsonValueKind.String)
                        {
                            return Invalid(request.Id, "system.run params.command array entries must be strings");
                        }

                        var value = part.GetString() ?? string.Empty;
                        if (first)
                        {
                            fileName = value;
                            first = false;
                        }
                        else
                        {
                            args.Add(value);
                        }
                    }

                    if (string.IsNullOrWhiteSpace(fileName)) return Invalid(request.Id, "system.run command array cannot be empty");
                    result = await RunProcessAsync(fileName, args.ToArray(), null, timeoutMs);
                }
                else if (commandEl.ValueKind == JsonValueKind.String)
                {
                    var commandText = commandEl.GetString();
                    if (string.IsNullOrWhiteSpace(commandText)) return Invalid(request.Id, "system.run command string cannot be empty");

                    if (OperatingSystem.IsWindows())
                        result = await RunProcessAsync("cmd.exe", new[] { "/c", commandText }, null, timeoutMs);
                    else
                        result = await RunProcessAsync("bash", new[] { "-lc", commandText }, null, timeoutMs);
                }
                else
                {
                    return Invalid(request.Id, "system.run params.command must be string or string[]");
                }
            }
            else
            {
                return Invalid(request.Id, "system.run requires params.command");
            }

            var payload = new
            {
                ok = result.ExitCode == 0 && !result.TimedOut,
                timedOut = result.TimedOut,
                timeoutMs,
                exitCode = result.ExitCode,
                stdout = result.StdOut,
                stderr = result.StdErr,
            };

            return new BridgeInvokeResponse
            {
                Id = request.Id,
                Ok = result.ExitCode == 0 && !result.TimedOut,
                PayloadJSON = ToJson(payload),
                Error = (result.ExitCode == 0 && !result.TimedOut)
                    ? null
                    : new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = result.TimedOut
                            ? $"system.run timed out after {timeoutMs ?? 0}ms"
                            : $"system.run failed with exit code {result.ExitCode}"
                    }
            };
        }

        private async Task<BridgeInvokeResponse> HandleScreenCaptureAsync(BridgeInvokeRequest request)
        {
            if (!OperatingSystem.IsWindows())
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = "screen.capture is only available on Windows"
                    }
                };
            }

            var root = ParseParams(request.ParamsJSON);

            // Clean contract: reject deprecated/legacy params.
            var legacyParams = new[] { "path", "handle", "route", "sendToAgent", "deliver" };
            if (root != null)
            {
                foreach (var legacy in legacyParams)
                {
                    if (root.Value.TryGetProperty(legacy, out _))
                    {
                        return Invalid(request.Id, $"screen.capture params.{legacy} is no longer supported");
                    }
                }
            }

            if (root != null && root.Value.TryGetProperty("mode", out var modeEl) && modeEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.mode must be a string");
            }
            if (root != null && root.Value.TryGetProperty("screenIndex", out var screenEl) && screenEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.capture params.screenIndex must be a number");
            }
            if (root != null && root.Value.TryGetProperty("windowHandle", out var whEl) && whEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.capture params.windowHandle must be a number");
            }
            if (root != null && root.Value.TryGetProperty("format", out var fmtEl) && fmtEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.format must be a string");
            }
            if (root != null && root.Value.TryGetProperty("message", out var msgEl) && msgEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.message must be a string");
            }
            if (root != null && root.Value.TryGetProperty("sessionKey", out var skEl) && skEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.sessionKey must be a string");
            }
            if (root != null && root.Value.TryGetProperty("channel", out var chEl) && chEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.channel must be a string");
            }
            if (root != null && root.Value.TryGetProperty("to", out var toEl) && toEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.to must be a string");
            }
            if (root != null && root.Value.TryGetProperty("outputPath", out var opEl) && opEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.capture params.outputPath must be a string");
            }
            if (root != null && root.Value.TryGetProperty("maxWidth", out var mwEl) && mwEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.capture params.maxWidth must be a number");
            }
            if (root != null && root.Value.TryGetProperty("quality", out var qEl) && qEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.capture params.quality must be a number");
            }
            if (root != null && root.Value.TryGetProperty("maxInlineBytes", out var mibEl) && mibEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.capture params.maxInlineBytes must be a number");
            }

            var mode = root != null && root.Value.TryGetProperty("mode", out var modeVal) && modeVal.ValueKind == JsonValueKind.String
                ? (modeVal.GetString() ?? "deliver").Trim().ToLowerInvariant()
                : "deliver";

            if (mode != "deliver" && mode != "file" && mode != "data")
            {
                return Invalid(request.Id, "screen.capture params.mode must be one of: deliver, file, data");
            }

            var screenIndex = 0;
            if (root != null && root.Value.TryGetProperty("screenIndex", out var sIdx) && sIdx.ValueKind == JsonValueKind.Number)
            {
                if (!sIdx.TryGetInt32(out screenIndex))
                {
                    return Invalid(request.Id, "screen.capture params.screenIndex must be a 32-bit integer");
                }

                if (screenIndex < 0)
                {
                    return Invalid(request.Id, "screen.capture params.screenIndex must be >= 0");
                }
            }

            var format = root != null && root.Value.TryGetProperty("format", out var fmt) && fmt.ValueKind == JsonValueKind.String
                ? (fmt.GetString() ?? "png").Trim().ToLowerInvariant()
                : "png";
            if (format != "png" && format != "jpg" && format != "jpeg")
            {
                return Invalid(request.Id, "screen.capture params.format must be one of: png, jpg, jpeg");
            }

            var outputPath = root != null && root.Value.TryGetProperty("outputPath", out var pathEl) && pathEl.ValueKind == JsonValueKind.String
                ? (pathEl.GetString() ?? string.Empty).Trim()
                : string.Empty;

            long windowHandle = 0;
            if (root != null && root.Value.TryGetProperty("windowHandle", out var wh) && wh.ValueKind == JsonValueKind.Number)
            {
                windowHandle = wh.TryGetInt64(out var v) ? v : (long)wh.GetDouble();
            }

            var sessionKey = root != null && root.Value.TryGetProperty("sessionKey", out var sk) && sk.ValueKind == JsonValueKind.String
                ? (sk.GetString() ?? string.Empty).Trim()
                : string.Empty;
            var message = root != null && root.Value.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String
                ? (msg.GetString() ?? "Desktop screenshot")
                : "Desktop screenshot";
            var channel = root != null && root.Value.TryGetProperty("channel", out var ch) && ch.ValueKind == JsonValueKind.String
                ? (ch.GetString() ?? string.Empty).Trim()
                : string.Empty;
            var to = root != null && root.Value.TryGetProperty("to", out var toVal) && toVal.ValueKind == JsonValueKind.String
                ? (toVal.GetString() ?? string.Empty).Trim()
                : string.Empty;
            var maxWidth = 1600;
            if (root != null && root.Value.TryGetProperty("maxWidth", out var mw) && mw.ValueKind == JsonValueKind.Number)
            {
                if (!mw.TryGetInt32(out maxWidth))
                {
                    return Invalid(request.Id, "screen.capture params.maxWidth must be a 32-bit integer");
                }
            }
            var quality = root != null && root.Value.TryGetProperty("quality", out var qualityEl) && qualityEl.ValueKind == JsonValueKind.Number
                ? qualityEl.GetDouble()
                : 0.85;
            var maxInlineBytes = 1_500_000;
            if (root != null && root.Value.TryGetProperty("maxInlineBytes", out var maxInlineEl) && maxInlineEl.ValueKind == JsonValueKind.Number)
            {
                if (!maxInlineEl.TryGetInt32(out maxInlineBytes))
                {
                    return Invalid(request.Id, "screen.capture params.maxInlineBytes must be a 32-bit integer");
                }
            }

            if (maxWidth <= 0)
            {
                return Invalid(request.Id, "screen.capture params.maxWidth must be > 0");
            }
            if (quality <= 0 || quality > 1)
            {
                return Invalid(request.Id, "screen.capture params.quality must be in range (0, 1]");
            }
            if (maxInlineBytes <= 0)
            {
                return Invalid(request.Id, "screen.capture params.maxInlineBytes must be > 0");
            }

            if (mode == "deliver")
            {
                if (_rpc == null)
                {
                    return Invalid(request.Id, "screen.capture mode=deliver requires gateway RPC client");
                }
                if (string.IsNullOrWhiteSpace(channel) || string.IsNullOrWhiteSpace(to))
                {
                    return Invalid(request.Id, "screen.capture mode=deliver requires params.channel and params.to");
                }
            }

            if (mode == "file" && string.IsNullOrWhiteSpace(outputPath))
            {
                return Invalid(request.Id, "screen.capture mode=file requires params.outputPath");
            }

            try
            {
                var source = windowHandle != 0 ? "window" : "screen";
                (byte[] bytes, int width, int height) raw;
                if (windowHandle != 0)
                {
                    raw = await _screen.CaptureWindowBytesAsync(windowHandle, format);
                }
                else
                {
                    raw = await _screen.CaptureScreenshotBytesAsync(screenIndex, format);
                }

                if (raw.bytes.Length == 0)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "screen.capture failed"
                        }
                    };
                }

                if (mode == "deliver")
                {
                    var encoded = ImageEncoding.EncodeJpegBase64(raw.bytes, maxWidth, quality);
                    if (string.IsNullOrWhiteSpace(encoded.Base64))
                    {
                        return new BridgeInvokeResponse
                        {
                            Id = request.Id,
                            Ok = false,
                            Error = new OpenClawNodeError
                            {
                                Code = OpenClawNodeErrorCode.Unavailable,
                                Message = "screen.capture encode failed"
                            }
                        };
                    }

                    var agentRequest = new
                    {
                        message,
                        sessionKey = string.IsNullOrWhiteSpace(sessionKey) ? null : sessionKey,
                        deliver = true,
                        channel,
                        to,
                        attachments = new[]
                        {
                            new
                            {
                                mimeType = encoded.MimeType,
                                fileName = $"screenshot.{encoded.Format}",
                                content = encoded.Base64
                            }
                        }
                    };

                    await _rpc!.SendRequestAsync(
                        method: "node.event",
                        @params: new { @event = "agent.request", payload = agentRequest },
                        cancellationToken: CancellationToken.None);

                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = true,
                        PayloadJSON = ToJson(new
                        {
                            ok = true,
                            mode,
                            target = new
                            {
                                source,
                                screenIndex,
                                windowHandle = windowHandle == 0 ? (long?)null : windowHandle
                            },
                            capture = new { format, bytes = raw.bytes.Length, width = raw.width, height = raw.height },
                            attachment = new { format = encoded.Format, mimeType = encoded.MimeType, bytes = encoded.Bytes, width = encoded.Width, height = encoded.Height },
                            delivery = new
                            {
                                @event = "agent.request",
                                channel,
                                to,
                                sessionKey = string.IsNullOrWhiteSpace(sessionKey) ? null : sessionKey
                            }
                        })
                    };
                }

                if (mode == "file")
                {
                    var effectivePath = outputPath;
                    var ext = Path.GetExtension(effectivePath);
                    if (string.IsNullOrWhiteSpace(ext))
                    {
                        effectivePath += "." + (format == "jpeg" ? "jpg" : format);
                    }

                    byte[] outputBytes;
                    string outputFormat;
                    string mimeType;
                    int outWidth;
                    int outHeight;

                    if (format == "jpg" || format == "jpeg")
                    {
                        var encoded = ImageEncoding.EncodeJpegBase64(raw.bytes, maxWidth, quality);
                        if (string.IsNullOrWhiteSpace(encoded.Base64))
                        {
                            return new BridgeInvokeResponse
                            {
                                Id = request.Id,
                                Ok = false,
                                Error = new OpenClawNodeError
                                {
                                    Code = OpenClawNodeErrorCode.Unavailable,
                                    Message = "screen.capture encode failed"
                                }
                            };
                        }

                        outputBytes = Convert.FromBase64String(encoded.Base64);
                        outputFormat = encoded.Format;
                        mimeType = encoded.MimeType;
                        outWidth = encoded.Width;
                        outHeight = encoded.Height;
                    }
                    else
                    {
                        outputBytes = raw.bytes;
                        outputFormat = "png";
                        mimeType = "image/png";
                        outWidth = raw.width;
                        outHeight = raw.height;
                    }

                    var parent = Path.GetDirectoryName(effectivePath);
                    if (!string.IsNullOrWhiteSpace(parent))
                    {
                        Directory.CreateDirectory(parent);
                    }
                    await File.WriteAllBytesAsync(effectivePath, outputBytes);

                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = true,
                        PayloadJSON = ToJson(new
                        {
                            ok = true,
                            mode,
                            target = new
                            {
                                source,
                                screenIndex,
                                windowHandle = windowHandle == 0 ? (long?)null : windowHandle
                            },
                            capture = new { format, bytes = raw.bytes.Length, width = raw.width, height = raw.height },
                            file = new { path = effectivePath, format = outputFormat, mimeType, bytes = outputBytes.Length, width = outWidth, height = outHeight }
                        })
                    };
                }

                {
                    var encoded = ImageEncoding.EncodeJpegBase64(raw.bytes, maxWidth, quality);
                    if (string.IsNullOrWhiteSpace(encoded.Base64))
                    {
                        return new BridgeInvokeResponse
                        {
                            Id = request.Id,
                            Ok = false,
                            Error = new OpenClawNodeError
                            {
                                Code = OpenClawNodeErrorCode.Unavailable,
                                Message = "screen.capture encode failed"
                            }
                        };
                    }

                    if (encoded.Bytes > maxInlineBytes)
                    {
                        return Invalid(request.Id, "screen.capture mode=data exceeds maxInlineBytes; use mode=deliver or mode=file");
                    }

                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = true,
                        PayloadJSON = ToJson(new
                        {
                            ok = true,
                            mode,
                            target = new
                            {
                                source,
                                screenIndex,
                                windowHandle = windowHandle == 0 ? (long?)null : windowHandle
                            },
                            capture = new { format, bytes = raw.bytes.Length, width = raw.width, height = raw.height },
                            inline = new { format = encoded.Format, mimeType = encoded.MimeType, bytes = encoded.Bytes, width = encoded.Width, height = encoded.Height, base64 = encoded.Base64 }
                        })
                    };
                }
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"screen.capture failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleDevScreenshotAsync(BridgeInvokeRequest request)
        {
            if (!OperatingSystem.IsWindows())
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = "screen.capture is only available on Windows"
                    }
                };
            }

            var root = ParseParams(request.ParamsJSON);
            var outPath = root != null && root.Value.TryGetProperty("path", out var pEl) && pEl.ValueKind == JsonValueKind.String
                ? (pEl.GetString() ?? string.Empty).Trim()
                : string.Empty;

            if (string.IsNullOrWhiteSpace(outPath))
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                outPath = Path.Combine(home, "Pictures", "OpenClaw", "dev-screenshot-latest.jpg");
            }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? Directory.GetCurrentDirectory());
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.InvalidRequest,
                        Message = $"Invalid screenshot path: {ex.Message}"
                    }
                };
            }

            var ps = "$ErrorActionPreference='Stop'; " +
                     "Add-Type -AssemblyName System.Windows.Forms; " +
                     "Add-Type -AssemblyName System.Drawing; " +
                     "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
                     "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); " +
                     "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
                     "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
                     "$bmp.Save('" + outPath.Replace("'", "''") + "',[System.Drawing.Imaging.ImageFormat]::Jpeg); " +
                     "$g.Dispose(); $bmp.Dispose(); " +
                     "Write-Output 'OK'";

            var capture = await RunProcessAsync("powershell", new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps });
            if (capture.ExitCode != 0 || !File.Exists(outPath))
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = "screen.capture failed"
                    },
                    PayloadJSON = ToJson(new
                    {
                        ok = false,
                        path = outPath,
                        exitCode = capture.ExitCode,
                        stdout = capture.StdOut,
                        stderr = capture.StdErr
                    })
                };
            }

            var automation = new AutomationService();
            var windows = await automation.ListWindowsAsync();
            var focused = windows.FirstOrDefault(w => w.IsFocused);

            return new BridgeInvokeResponse
            {
                Id = request.Id,
                Ok = true,
                PayloadJSON = ToJson(new
                {
                    ok = true,
                    path = outPath,
                    focusedTitle = focused?.Title,
                    focusedProcess = focused?.Process
                })
            };
        }

        
        private async Task<BridgeInvokeResponse> HandleScreenListAsync(BridgeInvokeRequest request)
        {
            ScreenCaptureService.ScreenDisplayInfo[] displays;
            try
            {
                var svc = new ScreenCaptureService();
                displays = await svc.ListDisplaysAsync();
            }
            catch
            {
                // Keep command resilient in mixed environments; expose empty list instead of hard error.
                displays = Array.Empty<ScreenCaptureService.ScreenDisplayInfo>();
            }

            var payload = new
            {
                displays
            };

            return new BridgeInvokeResponse
            {
                Id = request.Id,
                Ok = true,
                PayloadJSON = ToJson(payload)
            };
        }

        private async Task<BridgeInvokeResponse> HandleScreenRecordAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);

            if (root != null && root.Value.TryGetProperty("durationMs", out var durationEl) && durationEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.record params.durationMs must be a number");
            }

            if (root != null && root.Value.TryGetProperty("fps", out var fpsEl) && fpsEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.record params.fps must be a number");
            }

            if (root != null && root.Value.TryGetProperty("includeAudio", out var audioEl) &&
                audioEl.ValueKind != JsonValueKind.True && audioEl.ValueKind != JsonValueKind.False)
            {
                return Invalid(request.Id, "screen.record params.includeAudio must be a boolean");
            }

            if (root != null && root.Value.TryGetProperty("screenIndex", out var screenEl) && screenEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "screen.record params.screenIndex must be a number");
            }

            if (root != null && root.Value.TryGetProperty("captureApi", out var apiEl) && apiEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "screen.record params.captureApi must be a string");
            }

            if (root != null && root.Value.TryGetProperty("lowLatency", out var lowEl) &&
                lowEl.ValueKind != JsonValueKind.True && lowEl.ValueKind != JsonValueKind.False)
            {
                return Invalid(request.Id, "screen.record params.lowLatency must be a boolean");
            }

            var durationMs = 10000;
            if (root != null && root.Value.TryGetProperty("durationMs", out var d) && d.ValueKind == JsonValueKind.Number)
            {
                if (!d.TryGetInt32(out durationMs))
                {
                    return Invalid(request.Id, "screen.record params.durationMs must be a 32-bit integer");
                }

                if (durationMs <= 0)
                {
                    return Invalid(request.Id, "screen.record params.durationMs must be > 0");
                }
            }

            var fps = 10;
            if (root != null && root.Value.TryGetProperty("fps", out var f) && f.ValueKind == JsonValueKind.Number)
            {
                if (!f.TryGetInt32(out fps))
                {
                    return Invalid(request.Id, "screen.record params.fps must be a 32-bit integer");
                }

                if (fps <= 0)
                {
                    return Invalid(request.Id, "screen.record params.fps must be > 0");
                }
            }

            var includeAudio = root != null && root.Value.TryGetProperty("includeAudio", out var a) &&
                               (a.ValueKind == JsonValueKind.True || a.ValueKind == JsonValueKind.False)
                ? a.GetBoolean()
                : true;

            var screenIndex = 0;
            if (root != null && root.Value.TryGetProperty("screenIndex", out var sIdx) && sIdx.ValueKind == JsonValueKind.Number)
            {
                if (!sIdx.TryGetInt32(out screenIndex))
                {
                    return Invalid(request.Id, "screen.record params.screenIndex must be a 32-bit integer");
                }

                if (screenIndex < 0)
                {
                    return Invalid(request.Id, "screen.record params.screenIndex must be >= 0");
                }
            }

            var captureApi = root != null && root.Value.TryGetProperty("captureApi", out var api) && api.ValueKind == JsonValueKind.String
                ? (api.GetString() ?? "auto")
                : "auto";

            var lowLatency = root != null && root.Value.TryGetProperty("lowLatency", out var ll) &&
                             (ll.ValueKind == JsonValueKind.True || ll.ValueKind == JsonValueKind.False)
                ? ll.GetBoolean()
                : false;

            try
            {
                var svc = new ScreenCaptureService();
                var record = await svc.RecordScreenAsBase64Async(durationMs, fps, includeAudio, screenIndex, captureApi, lowLatency);

                var payload = new
                {
                    format = "mp4",
                    base64 = record.Base64,
                    durationMs,
                    fps,
                    screenIndex,
                    hasAudio = includeAudio,
                    captureApi = record.CaptureApi,
                    hardwareEncoding = record.HardwareEncoding,
                    lowLatency = record.LowLatency
                };

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(payload)
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Screen recording failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleCameraListAsync(BridgeInvokeRequest request)
        {
            try
            {
                var svc = new CameraCaptureService();
                var devices = await svc.ListDevicesAsync();

                var payload = new
                {
                    devices
                };

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(payload)
                };
            }
            catch
            {
                // Keep command resilient in mixed environments; expose empty list instead of hard error.
                var payload = new { devices = Array.Empty<CameraCaptureService.CameraDeviceInfo>() };
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(payload)
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleCameraSnapAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);

            var facing = root != null && root.Value.TryGetProperty("facing", out var f) && f.ValueKind == JsonValueKind.String
                ? (f.GetString() ?? "front")
                : "front";

            if (!string.Equals(facing, "front", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(facing, "back", StringComparison.OrdinalIgnoreCase))
            {
                return Invalid(request.Id, "camera.snap params.facing must be 'front' or 'back'");
            }

            if (root != null && root.Value.TryGetProperty("format", out var formatEl) && formatEl.ValueKind == JsonValueKind.String)
            {
                var format = formatEl.GetString();
                if (!string.IsNullOrWhiteSpace(format) && !string.Equals(format, "jpg", StringComparison.OrdinalIgnoreCase))
                {
                    return Invalid(request.Id, "camera.snap params.format must be 'jpg'");
                }
            }

            int? maxWidth = null;
            if (root != null && root.Value.TryGetProperty("maxWidth", out var w) && w.ValueKind == JsonValueKind.Number)
            {
                if (!w.TryGetInt32(out var parsedMaxWidth))
                {
                    return Invalid(request.Id, "camera.snap params.maxWidth must be a 32-bit integer");
                }

                maxWidth = parsedMaxWidth;
                if (maxWidth.Value <= 0)
                {
                    return Invalid(request.Id, "camera.snap params.maxWidth must be > 0");
                }
            }

            var quality = root != null && root.Value.TryGetProperty("quality", out var q) && q.ValueKind == JsonValueKind.Number
                ? q.GetDouble()
                : (double?)null;

            if (quality.HasValue && (quality.Value < 0 || quality.Value > 1))
            {
                return Invalid(request.Id, "camera.snap params.quality must be between 0 and 1");
            }

            int? delayMs = null;
            if (root != null && root.Value.TryGetProperty("delayMs", out var d) && d.ValueKind == JsonValueKind.Number)
            {
                if (!d.TryGetInt32(out var parsedDelayMs))
                {
                    return Invalid(request.Id, "camera.snap params.delayMs must be a 32-bit integer");
                }

                delayMs = parsedDelayMs;
                if (delayMs.Value < 0)
                {
                    return Invalid(request.Id, "camera.snap params.delayMs must be >= 0");
                }
            }

            var deviceId = root != null && root.Value.TryGetProperty("deviceId", out var id) && id.ValueKind == JsonValueKind.String
                ? id.GetString()
                : null;

            try
            {
                var svc = new CameraCaptureService();
                var (base64, width, height) = await svc.CaptureJpegAsBase64Async(facing.ToLowerInvariant(), maxWidth, quality, delayMs, deviceId);

                if (OperatingSystem.IsWindows() && width <= 1 && height <= 1)
                {
                    var reason = string.IsNullOrWhiteSpace(svc.LastError) ?
                        "Camera capture unavailable. Check Windows Settings > Privacy & security > Camera, enable 'Camera access' and 'Let desktop apps access your camera'." :
                        $"Camera capture unavailable: {svc.LastError}. Check Windows Settings > Privacy & security > Camera and enable desktop app camera access.";

                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = reason
                        }
                    };
                }

                var payload = new
                {
                    format = "jpg",
                    base64,
                    width,
                    height
                };

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(payload)
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Camera snap failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleWindowListAsync(BridgeInvokeRequest request)
        {
            try
            {
                var svc = new AutomationService();
                var windows = await svc.ListWindowsAsync();
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { windows })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Window list failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleWindowFocusAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            long? handle = null;
            if (root != null && root.Value.TryGetProperty("handle", out var h) && h.ValueKind == JsonValueKind.Number)
            {
                if (!h.TryGetInt64(out var parsedHandle))
                {
                    return Invalid(request.Id, "window.focus params.handle must be a 64-bit integer");
                }

                handle = parsedHandle;
            }
            var titleContains = root != null && root.Value.TryGetProperty("titleContains", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()
                : null;

            if ((!handle.HasValue || handle.Value == 0) && string.IsNullOrWhiteSpace(titleContains))
            {
                return Invalid(request.Id, "window.focus requires params.handle or params.titleContains");
            }

            try
            {
                var svc = new AutomationService();
                var focused = await svc.FocusWindowAsync(handle, titleContains);
                if (!focused)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Unable to focus requested window"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Window focus failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleWindowRectAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            long? handle = null;
            if (root != null && root.Value.TryGetProperty("handle", out var h) && h.ValueKind == JsonValueKind.Number)
            {
                if (!h.TryGetInt64(out var parsedHandle))
                {
                    return Invalid(request.Id, "window.rect params.handle must be a 64-bit integer");
                }

                handle = parsedHandle;
            }
            var titleContains = root != null && root.Value.TryGetProperty("titleContains", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()
                : null;

            if ((!handle.HasValue || handle.Value == 0) && string.IsNullOrWhiteSpace(titleContains))
            {
                return Invalid(request.Id, "window.rect requires params.handle or params.titleContains");
            }

            try
            {
                var svc = new AutomationService();
                var rect = await svc.GetWindowRectAsync(handle, titleContains);
                if (rect == null)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Unable to resolve requested window rect"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { rect })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Window rect failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleInputTypeAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            var text = root != null && root.Value.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()
                : null;

            if (string.IsNullOrEmpty(text))
            {
                return Invalid(request.Id, "input.type requires params.text");
            }

            try
            {
                var svc = new AutomationService();
                var ok = await svc.TypeTextAsync(text);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Typing input failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Typing input failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleInputKeyAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            var key = root != null && root.Value.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String
                ? k.GetString()
                : null;

            if (string.IsNullOrWhiteSpace(key))
            {
                return Invalid(request.Id, "input.key requires params.key");
            }

            try
            {
                var svc = new AutomationService();
                var ok = await svc.SendKeyAsync(key);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Sending key input failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Sending key input failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleInputClickAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "input.click requires params.x and params.y");
            }

            if (!root.Value.TryGetProperty("x", out var xEl) || xEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "input.click requires numeric params.x");
            }

            if (!root.Value.TryGetProperty("y", out var yEl) || yEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "input.click requires numeric params.y");
            }

            if (!xEl.TryGetInt32(out var x) || !yEl.TryGetInt32(out var y))
            {
                return Invalid(request.Id, "input.click params.x and params.y must be integers");
            }
            var button = root.Value.TryGetProperty("button", out var bEl) && bEl.ValueKind == JsonValueKind.String
                ? (bEl.GetString() ?? "primary")
                : "primary";

            if (!string.Equals(button, "left", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "right", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "primary", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "secondary", StringComparison.OrdinalIgnoreCase))
            {
                return Invalid(request.Id, "input.click params.button must be 'primary', 'secondary', 'left', or 'right'");
            }

            var doubleClick = root.Value.TryGetProperty("doubleClick", out var dEl) &&
                              (dEl.ValueKind == JsonValueKind.True || dEl.ValueKind == JsonValueKind.False)
                ? dEl.GetBoolean()
                : false;

            try
            {
                var svc = new AutomationService();
                var ok = await svc.ClickAsync(x, y, button.ToLowerInvariant(), doubleClick);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Mouse click failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true, x, y, button = button.ToLowerInvariant(), doubleClick })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Mouse click failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleInputScrollAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "input.scroll requires params.deltaY");
            }

            if (!root.Value.TryGetProperty("deltaY", out var deltaEl) || deltaEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "input.scroll requires numeric params.deltaY");
            }

            if (!deltaEl.TryGetInt32(out var deltaY))
            {
                return Invalid(request.Id, "input.scroll params.deltaY must be a 32-bit integer");
            }

            if (deltaY == 0)
            {
                return Invalid(request.Id, "input.scroll params.deltaY must be non-zero");
            }

            int? x = null;
            int? y = null;

            if (root.Value.TryGetProperty("x", out var xEl))
            {
                if (xEl.ValueKind != JsonValueKind.Number)
                {
                    return Invalid(request.Id, "input.scroll params.x must be numeric when provided");
                }

                if (!xEl.TryGetInt32(out var parsedX))
                {
                    return Invalid(request.Id, "input.scroll params.x must be a 32-bit integer when provided");
                }

                x = parsedX;
            }

            if (root.Value.TryGetProperty("y", out var yEl))
            {
                if (yEl.ValueKind != JsonValueKind.Number)
                {
                    return Invalid(request.Id, "input.scroll params.y must be numeric when provided");
                }

                if (!yEl.TryGetInt32(out var parsedY))
                {
                    return Invalid(request.Id, "input.scroll params.y must be a 32-bit integer when provided");
                }

                y = parsedY;
            }

            if (x.HasValue ^ y.HasValue)
            {
                return Invalid(request.Id, "input.scroll requires both params.x and params.y when targeting coordinates");
            }

            try
            {
                var svc = new AutomationService();
                var ok = await svc.ScrollAsync(deltaY, x, y);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Mouse scroll failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true, deltaY, x, y })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Mouse scroll failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleInputClickRelativeAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "input.click.relative requires params.offsetX and params.offsetY");
            }

            var handle = root.Value.TryGetProperty("handle", out var h) && h.ValueKind == JsonValueKind.Number
                ? h.GetInt64()
                : (long?)null;
            var titleContains = root.Value.TryGetProperty("titleContains", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()
                : null;

            if ((!handle.HasValue || handle.Value == 0) && string.IsNullOrWhiteSpace(titleContains))
            {
                return Invalid(request.Id, "input.click.relative requires params.handle or params.titleContains");
            }

            if (!root.Value.TryGetProperty("offsetX", out var oxEl) || oxEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "input.click.relative requires numeric params.offsetX");
            }

            if (!root.Value.TryGetProperty("offsetY", out var oyEl) || oyEl.ValueKind != JsonValueKind.Number)
            {
                return Invalid(request.Id, "input.click.relative requires numeric params.offsetY");
            }

            if (!oxEl.TryGetInt32(out var offsetX) || !oyEl.TryGetInt32(out var offsetY))
            {
                return Invalid(request.Id, "input.click.relative params.offsetX and params.offsetY must be 32-bit integers");
            }
            var button = root.Value.TryGetProperty("button", out var bEl) && bEl.ValueKind == JsonValueKind.String
                ? (bEl.GetString() ?? "primary")
                : "primary";

            if (!string.Equals(button, "left", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "right", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "primary", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "secondary", StringComparison.OrdinalIgnoreCase))
            {
                return Invalid(request.Id, "input.click.relative params.button must be 'primary', 'secondary', 'left', or 'right'");
            }

            var doubleClick = root.Value.TryGetProperty("doubleClick", out var dEl) &&
                              (dEl.ValueKind == JsonValueKind.True || dEl.ValueKind == JsonValueKind.False)
                ? dEl.GetBoolean()
                : false;

            try
            {
                var svc = new AutomationService();
                var ok = await svc.ClickRelativeToWindowAsync(handle, titleContains, offsetX, offsetY, button.ToLowerInvariant(), doubleClick);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "Relative click failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true, offsetX, offsetY, button = button.ToLowerInvariant(), doubleClick })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"Relative click failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleUiFindAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "ui.find requires params");
            }

            if (!TryParseUiSelectorParams(request.Id, root.Value, out var handle, out var titleContains, out var name, out var automationId, out var controlType, out var timeoutMs, out var invalid))
            {
                return invalid!;
            }

            try
            {
                var svc = new AutomationService();
                var find = await svc.FindUiElementDetailedAsync(handle, titleContains, name, automationId, controlType, timeoutMs);
                if (!find.Found || find.Element == null)
                {
                    var details = BuildUiSelectorDebugDetails(handle, titleContains, name, automationId, controlType, timeoutMs, find.Reason, find.Strategy);
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI element not found"
                        },
                        PayloadJSON = ToJson(new { ok = false, details })
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { element = find.Element, strategy = find.Strategy })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"UI find failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleUiClickAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "ui.click requires params");
            }

            if (!TryParseUiSelectorParams(request.Id, root.Value, out var handle, out var titleContains, out var name, out var automationId, out var controlType, out var timeoutMs, out var invalid))
            {
                return invalid!;
            }

            var button = root.Value.TryGetProperty("button", out var bEl) && bEl.ValueKind == JsonValueKind.String
                ? (bEl.GetString() ?? "primary")
                : "primary";

            if (!string.Equals(button, "left", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "right", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "primary", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(button, "secondary", StringComparison.OrdinalIgnoreCase))
            {
                return Invalid(request.Id, "ui.click params.button must be 'primary', 'secondary', 'left', or 'right'");
            }

            var doubleClick = root.Value.TryGetProperty("doubleClick", out var dEl) &&
                              (dEl.ValueKind == JsonValueKind.True || dEl.ValueKind == JsonValueKind.False)
                ? dEl.GetBoolean()
                : false;

            try
            {
                var svc = new AutomationService();
                var find = await svc.FindUiElementDetailedAsync(handle, titleContains, name, automationId, controlType, timeoutMs);
                if (!find.Found || find.Element == null)
                {
                    var details = BuildUiSelectorDebugDetails(handle, titleContains, name, automationId, controlType, timeoutMs, find.Reason, find.Strategy);
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI click failed: element not found"
                        },
                        PayloadJSON = ToJson(new { ok = false, details })
                    };
                }

                var ok = await svc.ClickAsync(find.Element.CenterX, find.Element.CenterY, button.ToLowerInvariant(), doubleClick);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI click failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true, button = button.ToLowerInvariant(), doubleClick, strategy = find.Strategy, x = find.Element.CenterX, y = find.Element.CenterY })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"UI click failed: {ex.Message}"
                    }
                };
            }
        }

        private async Task<BridgeInvokeResponse> HandleUiTypeAsync(BridgeInvokeRequest request)
        {
            var root = ParseParams(request.ParamsJSON);
            if (root == null)
            {
                return Invalid(request.Id, "ui.type requires params");
            }

            if (!TryParseUiSelectorParams(request.Id, root.Value, out var handle, out var titleContains, out var name, out var automationId, out var controlType, out var timeoutMs, out var invalid))
            {
                return invalid!;
            }

            if (!root.Value.TryGetProperty("text", out var textEl) || textEl.ValueKind != JsonValueKind.String)
            {
                return Invalid(request.Id, "ui.type requires params.text");
            }

            var text = textEl.GetString();
            if (string.IsNullOrEmpty(text))
            {
                return Invalid(request.Id, "ui.type requires params.text");
            }

            try
            {
                var svc = new AutomationService();
                var find = await svc.FindUiElementDetailedAsync(handle, titleContains, name, automationId, controlType, timeoutMs);
                if (!find.Found || find.Element == null)
                {
                    var details = BuildUiSelectorDebugDetails(handle, titleContains, name, automationId, controlType, timeoutMs, find.Reason, find.Strategy);
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI type failed: element not found"
                        },
                        PayloadJSON = ToJson(new { ok = false, details })
                    };
                }

                var clicked = await svc.ClickAsync(find.Element.CenterX, find.Element.CenterY, "primary", false);
                if (!clicked)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI type failed: unable to focus element"
                        }
                    };
                }

                await Task.Delay(50);
                var ok = await svc.TypeTextAsync(text);
                if (!ok)
                {
                    return new BridgeInvokeResponse
                    {
                        Id = request.Id,
                        Ok = false,
                        Error = new OpenClawNodeError
                        {
                            Code = OpenClawNodeErrorCode.Unavailable,
                            Message = "UI type failed"
                        }
                    };
                }

                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = true,
                    PayloadJSON = ToJson(new { ok = true, strategy = find.Strategy, x = find.Element.CenterX, y = find.Element.CenterY })
                };
            }
            catch (Exception ex)
            {
                return new BridgeInvokeResponse
                {
                    Id = request.Id,
                    Ok = false,
                    Error = new OpenClawNodeError
                    {
                        Code = OpenClawNodeErrorCode.Unavailable,
                        Message = $"UI type failed: {ex.Message}"
                    }
                };
            }
        }

        private bool TryParseUiSelectorParams(
            string requestId,
            JsonElement root,
            out long? handle,
            out string? titleContains,
            out string? name,
            out string? automationId,
            out string? controlType,
            out int timeoutMs,
            out BridgeInvokeResponse? invalid)
        {
            invalid = null;
            handle = root.TryGetProperty("handle", out var hEl) && hEl.ValueKind == JsonValueKind.Number
                ? hEl.GetInt64()
                : (long?)null;
            titleContains = root.TryGetProperty("titleContains", out var tEl) && tEl.ValueKind == JsonValueKind.String
                ? tEl.GetString()
                : null;

            name = root.TryGetProperty("name", out var nEl) && nEl.ValueKind == JsonValueKind.String
                ? nEl.GetString()
                : null;
            automationId = root.TryGetProperty("automationId", out var aEl) && aEl.ValueKind == JsonValueKind.String
                ? aEl.GetString()
                : null;
            controlType = root.TryGetProperty("controlType", out var cEl) && cEl.ValueKind == JsonValueKind.String
                ? cEl.GetString()
                : null;

            timeoutMs = 1500;
            if (root.TryGetProperty("timeoutMs", out var tmEl) && tmEl.ValueKind == JsonValueKind.Number)
            {
                if (!tmEl.TryGetInt32(out timeoutMs))
                {
                    invalid = Invalid(requestId, "ui.* params.timeoutMs must be a 32-bit integer");
                    return false;
                }
            }

            if ((!handle.HasValue || handle.Value == 0) && string.IsNullOrWhiteSpace(titleContains))
            {
                invalid = Invalid(requestId, "ui.* requires params.handle or params.titleContains");
                return false;
            }

            if (string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(automationId) && string.IsNullOrWhiteSpace(controlType))
            {
                invalid = Invalid(requestId, "ui.* requires at least one selector: params.name, params.automationId, or params.controlType");
                return false;
            }

            if (timeoutMs <= 0)
            {
                invalid = Invalid(requestId, "ui.* params.timeoutMs must be > 0");
                return false;
            }

            return true;
        }

        private static object BuildUiSelectorDebugDetails(
            long? handle,
            string? titleContains,
            string? name,
            string? automationId,
            string? controlType,
            int timeoutMs,
            string? reason,
            string? strategy)
            => new
            {
                handle,
                titleContains,
                selectors = new
                {
                    name,
                    automationId,
                    controlType,
                },
                timeoutMs,
                reason = string.IsNullOrWhiteSpace(reason) ? "not-found" : reason,
                strategy = strategy ?? string.Empty,
            };

        private static BridgeInvokeResponse Invalid(string id, string message) => new()
        {
            Id = id,
            Ok = false,
            Error = new OpenClawNodeError
            {
                Code = OpenClawNodeErrorCode.InvalidRequest,
                Message = message
            }
        };

        private static JsonElement? ParseParams(string? paramsJson)
        {
            if (string.IsNullOrWhiteSpace(paramsJson)) return null;
            using var doc = JsonDocument.Parse(paramsJson);
            return doc.RootElement.Clone();
        }

        private static async Task<ProcessResult> RunProcessAsync(
            string fileName,
            string[] args,
            string? workingDirectory = null,
            int? timeoutMs = null)
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            if (!string.IsNullOrWhiteSpace(workingDirectory))
            {
                psi.WorkingDirectory = workingDirectory;
            }

            foreach (var arg in args) psi.ArgumentList.Add(arg);

            using var process = new Process { StartInfo = psi };
            process.Start();
            var stdOutTask = process.StandardOutput.ReadToEndAsync();
            var stdErrTask = process.StandardError.ReadToEndAsync();

            var timedOut = false;
            if (timeoutMs.HasValue)
            {
                using var timeoutCts = new CancellationTokenSource(timeoutMs.Value);
                try
                {
                    await process.WaitForExitAsync(timeoutCts.Token);
                }
                catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
                {
                    timedOut = true;
                    try
                    {
                        if (!process.HasExited)
                        {
                            process.Kill(entireProcessTree: true);
                        }
                    }
                    catch
                    {
                        // best effort
                    }

                    try
                    {
                        await process.WaitForExitAsync();
                    }
                    catch
                    {
                        // best effort
                    }
                }
            }
            else
            {
                await process.WaitForExitAsync();
            }

            var stdOut = await stdOutTask;
            var stdErr = await stdErrTask;

            return new ProcessResult
            {
                ExitCode = timedOut ? -1 : process.ExitCode,
                StdOut = stdOut,
                StdErr = stdErr,
                TimedOut = timedOut,
            };
        }

        private static Task<ProcessResult> RunProcessAsync(string fileName, params string[] args)
            => RunProcessAsync(fileName, args, null, null);

        private class ProcessResult
        {
            public int ExitCode { get; set; }
            public string StdOut { get; set; } = string.Empty;
            public string StdErr { get; set; } = string.Empty;
            public bool TimedOut { get; set; }
        }
    }
}
