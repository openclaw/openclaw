using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using ABB.Robotics.Controllers;
using ABB.Robotics.Controllers.Discovery;
using ABB.Robotics.Controllers.EventLogDomain;
using ABB.Robotics.Controllers.MotionDomain;
using ABB.Robotics.Controllers.RapidDomain;
using Task = ABB.Robotics.Controllers.RapidDomain.Task;

/// <summary>
/// ABB Robot Controller Bridge for OpenClaw Plugin
/// 针对 AI Agent 环境优化：全异步非阻塞、远程文件系统隔离、安全的模块覆盖与证书验证。
/// </summary>
public class ABBBridge
{
    private static Controller controller;
    private static bool isConnected = false;


    /// <summary>
    /// Connect to ABB robot controller (Async safe)
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> Connect(dynamic input)
    {
        try
        {
            string host = CoerceString(GetInputValue(input, "host"));
            if (string.IsNullOrWhiteSpace(host))
            {
                return new { success = false, error = "host is required" };
            }

            // Ensure previous session is fully released before reconnecting.
            if (controller != null)
            {
                try { controller.Dispose(); } catch { }
                controller = null;
                isConnected = false;
            }

            // 使用后台线程执行网络扫描，防止阻塞 Agent 主线程
            var controllers = await System.Threading.Tasks.Task.Run(() =>
            {
                var scanner = new NetworkScanner();
                scanner.Scan();
                return scanner.Controllers;
            });

            if (controllers == null || controllers.Count == 0)
                return new { success = false, error = "No ABB controllers discovered on the network." };

            string target = host.Trim();
            bool localRequested = target is "127.0.0.1" or "localhost" or "::1";
            ControllerInfo selectedInfo = null;

            // Match by IP first (most common), then Id/SystemId/system-name.
            foreach (ControllerInfo info in controllers)
            {
                string ip = info.IPAddress?.ToString() ?? string.Empty;
                if (string.Equals(ip, target, StringComparison.OrdinalIgnoreCase))
                {
                    selectedInfo = info;
                    break;
                }
            }

            if (selectedInfo == null)
            {
                foreach (ControllerInfo info in controllers)
                {
                    if (string.Equals(info.Id, target, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(info.SystemId.ToString(), target, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(info.SystemName, target, StringComparison.OrdinalIgnoreCase))
                    {
                        selectedInfo = info;
                        break;
                    }
                }
            }

            // Local RobotStudio usually exposes a virtual controller on 127.0.0.1.
            if (selectedInfo == null && localRequested)
            {
                selectedInfo = controllers.Cast<ControllerInfo>().FirstOrDefault(c => c.IsVirtual);
            }

            if (selectedInfo == null)
                return new { success = false, error = "Controller not found", requestedHost = target };

            // 恢复最稳定合法的方案：利用 validateServerCertificate = false 绕过 SDK 2025.1 的证书校验拦截
            controller = Controller.Connect(selectedInfo, ConnectionType.Standalone, validateServerCertificate: false);
            controller.Logon(UserInfo.DefaultUser);
            isConnected = controller.Connected;

            if (isConnected)
            {
                return new
                {
                    success = true,
                    systemName = controller.SystemName,
                    robotModel = controller.Name,
                    connected = true,
                    host = selectedInfo.IPAddress?.ToString(),
                    isVirtual = selectedInfo.IsVirtual,
                    dllVersion = "v5"
                };
            }
            return new { success = false, error = "Logon failed." };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Disconnect from controller
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> Disconnect(dynamic input)
    {
        try
        {
            if (controller != null)
            {
                controller.Dispose();
                isConnected = false;
            }
            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Scan ABB controllers on network
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ScanControllers(dynamic input)
    {
        try
        {
            var scanner = new NetworkScanner();
            scanner.Scan();
            var controllers = scanner.Controllers;

            var items = controllers
                .Cast<ControllerInfo>()
                .Select(ci => new
                {
                    ip = ci.IPAddress?.ToString(),
                    id = ci.Id,
                    isVirtual = ci.IsVirtual,
                    version = ci.Version?.ToString(),
                    systemId = ci.SystemId.ToString(),
                    systemName = ci.SystemName,
                    hostName = ci.HostName,
                    controllerName = ci.ControllerName
                })
                .ToArray();

            return new
            {
                success = true,
                total = items.Length,
                controllers = items
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Get controller status
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetStatus(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            var task = controller.Rapid.GetTask("T_ROB1");
            return new
            {
                success = true,
                operationMode = controller.OperatingMode.ToString(),
                motorState = controller.State.ToString(),
                rapidRunning = task.ExecutionStatus == TaskExecutionStatus.Running,
                rapidExecutionStatus = task.ExecutionStatus.ToString()
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Get robotware/system metadata
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetSystemInfo(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            return new
            {
                success = true,
                systemName = controller.SystemName,
                controllerName = controller.Name,
                robotWareName = controller.RobotWare?.Name,
                robotWareVersion = controller.RobotWare?.Version?.ToString(),
                isVirtual = controller.IsVirtual,
                systemId = controller.SystemId.ToString()
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Get service/runtime info
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetServiceInfo(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            MechanicalUnitServiceInfo info = controller.MotionSystem.ActiveMechanicalUnit.ServiceInfo;
            return new
            {
                success = true,
                elapsedProductionHours = info.ElapsedProductionTime.TotalHours,
                lastStart = info.LastStart.ToString("o")
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Get speed ratio
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetSpeedRatio(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            return new
            {
                success = true,
                speedRatio = controller.MotionSystem.SpeedRatio
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Set speed ratio 
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> SetSpeedRatio(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            int speed = (int)Math.Max(1, Math.Min(100, CoerceDouble(GetInputValue(input, "speed"), 100)));
            controller.MotionSystem.SpeedRatio = speed;
            return new
            {
                success = true,
                speedRatio = controller.MotionSystem.SpeedRatio
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Get current joint positions
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetJointPositions(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            // Keep consistent with FormMain.cs: read from active mechanical unit.
            var jt = controller.MotionSystem.ActiveMechanicalUnit.GetPosition();
            var robAx = jt.RobAx;

            return new { success = true, joints = new[] { robAx.Rax_1, robAx.Rax_2, robAx.Rax_3, robAx.Rax_4, robAx.Rax_5, robAx.Rax_6 } };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Load RAPID program
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> LoadRapidProgram(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string code = CoerceString(GetInputValue(input, "code"));
            string moduleName = CoerceString(GetInputValue(input, "moduleName"));
            
            Match m = Regex.Match(code.TrimStart(), @"(?i)^MODULE\s+([a-zA-Z0-9_]+)");
            if (m.Success)
            {
                moduleName = m.Groups[1].Value;
            }
            else if (string.IsNullOrWhiteSpace(moduleName))
            {
                moduleName = "OpenClawMotionMod";
            }
            
            string rapidCode = NormalizeRapidSpeedSymbols(code);

            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), false);
            EnsureRapidControlAccess(allowRealExecution);

            // 1. 在运行 Agent 的 PC 上生成临时文件
            // 注意：这里由于 localTempFilePath 是随机生成的 (如 AgentMod_123.mod)，直接推送到系统如果文件名与 MODULE 名称不一致，会在 LoadModule 阶段抛错 C0049003 或直接 parse error
            string localTempFilePath = CreateTempRapidFile(rapidCode, moduleName, out string fileName);
            string remoteSystemPath = $"{moduleName}.mod"; // 必须同名

            await System.Threading.Tasks.Task.Run(() =>
            {
                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    var task = controller.Rapid.GetTask("T_ROB1");

                    if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        Thread.Sleep(300);
                    }

                    // 步骤 1：从内存删除旧模块（若存在）
                    try { task.DeleteModule(moduleName); }
                    catch { /* 模块不存在时忽略 */ }

                    // 步骤 2：将模块文件推送到控制器 HOME 目录
                    SafePutFile(controller, localTempFilePath, remoteSystemPath, noSleep: false);

                    string loadPath = controller.FileSystem.RemoteDirectory.TrimEnd('/') + "/" + remoteSystemPath;

                    bool loaded = false;

                    // 对于虚拟控制器，SafePutFile 写入 HOME 后 VC 文件监视器会自动加载模块
                    // 先检查模块是否已被 VC 自动加载到内存
                    if (controller.IsVirtual)
                    {
                        Thread.Sleep(500);
                        try
                        {
                            loaded = task.GetModules().Any(mod =>
                                string.Equals(mod.Name, moduleName, StringComparison.OrdinalIgnoreCase));
                        }
                        catch { }
                    }

                    // 步骤 3：若 VC 未自动加载，显式调用 LoadModuleFromFile
                    if (!loaded)
                    {
                        loaded = task.LoadModuleFromFile(loadPath, RapidLoadMode.Add);
                        if (!loaded)
                        {
                            loaded = task.LoadModuleFromFile(loadPath, RapidLoadMode.Replace);
                        }
                    }

                    // LoadModuleFromFile 可能因其他模块预存的 RAPID 错误返回 false，
                    // 但我们的模块实际已成功加载。最终确认模块是否在内存中。
                    if (!loaded)
                    {
                        try
                        {
                            loaded = task.GetModules().Any(mod =>
                                string.Equals(mod.Name, moduleName, StringComparison.OrdinalIgnoreCase));
                        }
                        catch { }
                    }

                    if (!loaded)
                    {
                        // Collect ALL event log diagnostics across all categories
                        string diagnostics = "";
                        try
                        {
                            var sb = new System.Text.StringBuilder();
                            for (int catId = 0; catId <= 5; catId++)
                            {
                                try
                                {
                                    var cat = controller.EventLog.GetCategory(catId);
                                    if (cat == null) continue;
                                    foreach (EventLogMessage msg in cat.Messages.Cast<EventLogMessage>()
                                        .OrderByDescending(em => em.Timestamp).Take(5))
                                    {
                                        // Only include very recent messages (last 30s)
                                        if ((DateTime.Now - msg.Timestamp).TotalSeconds > 30) break;
                                        sb.AppendLine($"  [{catId}:{msg.Number}] {msg.Title} | {msg.Body}");
                                    }
                                }
                                catch { }
                            }
                            diagnostics = sb.ToString();
                            if (string.IsNullOrWhiteSpace(diagnostics)) diagnostics = "<No recent events within 30s>";
                        }
                        catch { diagnostics = "<Failed to read Event Log>"; }

                        // Try to get .err file
                        string errFileName = remoteSystemPath.Replace(".mod", ".err");
                        string tempErrFile = Path.Combine(Path.GetTempPath(), errFileName);
                        string errContent = null;
                        try
                        {
                            SafeGetFile(controller, tempErrFile, errFileName);
                            errContent = File.ReadAllText(tempErrFile);
                        }
                        catch { }

                        // Also try to read .err from physical HOME path for virtual controllers
                        if (errContent == null && controller.IsVirtual)
                        {
                            string homeDir2 = controller.FileSystem.RemoteDirectory.Replace("ctrl:", "");
                            string physicalErrPath = Path.Combine(homeDir2, errFileName);
                            if (File.Exists(physicalErrPath))
                            {
                                try { errContent = File.ReadAllText(physicalErrPath); } catch { }
                            }
                        }

                        string codeSnippet = "";
                        try
                        {
                            string homeDir2 = controller.FileSystem.RemoteDirectory.Replace("ctrl:", "");
                            string physicalModPath2 = Path.Combine(homeDir2, remoteSystemPath);
                            codeSnippet = File.Exists(physicalModPath2) ? File.ReadAllText(physicalModPath2) : "<file not found on disk>";
                        } catch { }

                        if (!string.IsNullOrWhiteSpace(errContent))
                        {
                            throw new InvalidOperationException($"Controller failed to load the module '{moduleName}'. Syntax Errors:\n{errContent}");
                        }
                        else
                        {
                            throw new Exception(
                                $"Controller failed to load module '{moduleName}' (Add+Replace both failed).\n" +
                                $"Recent Event Logs:\n{diagnostics}\n" +
                                $"Module code sent:\n{codeSnippet}");
                        }
                    }

                    // 重置指针，加入合理的重试机制
                    for (int i = 0; i < 3; i++)
                    {
                        try { task.ResetProgramPointer(); break; }
                        catch { Thread.Sleep(100); }
                    }
                }

                // 4. 清理控制器内的临时文件（虚拟控制器跳过，避免 VC 文件监视器干扰）
                if (!controller.IsVirtual)
                {
                    try { controller.FileSystem.RemoveFile(remoteSystemPath); } catch { }
                }
            });

            // 清理本地临时文件
            TryDeleteTempFile(localTempFilePath);

            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Start RAPID execution
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> StartRapid(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), false);
            EnsureRapidControlAccess(allowRealExecution);

            using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
            {
                StartResult result = controller.Rapid.Start(RegainMode.Continue, ExecutionMode.Continuous, ExecutionCycle.Once);
                if (result != StartResult.Ok)
                {
                    result = controller.Rapid.Start(RegainMode.Regain, ExecutionMode.Continuous, ExecutionCycle.Once);
                }
                if (result != StartResult.Ok) return new { success = false, error = $"RAPID start failed: {result}" };
            }
            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Stop RAPID execution
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> StopRapid(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            EnsureRapidControlGrant();
            using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
            {
                controller.Rapid.GetTask("T_ROB1").Stop(StopMode.Immediate);
            }
            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }


    /// <summary>
    /// Get world pose
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetWorldPosition(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            double rx;
            double ry;
            double rz;
            RobTarget robTarget = controller.MotionSystem.ActiveMechanicalUnit.GetPosition(CoordinateSystemType.World);
            robTarget.Rot.ToEulerAngles(out rx, out ry, out rz);

            return new
            {
                success = true,
                x = robTarget.Trans.X,
                y = robTarget.Trans.Y,
                z = robTarget.Trans.Z,
                rx,
                ry,
                rz
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Read event log entries
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> GetEventLogEntries(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            int limit = (int)Math.Max(1, Math.Min(200, CoerceDouble(GetInputValue(input, "limit"), 20)));
            int categoryId = (int)CoerceDouble(GetInputValue(input, "categoryId"), 0);
            EventLogCategory cat = controller.EventLog.GetCategory(categoryId);

            if (cat == null)
            {
                return new { success = false, error = "Event log category not found", categoryId };
            }

            var entries = cat.Messages
                .Cast<EventLogMessage>()
                .OrderByDescending(em => em.Timestamp)
                .Take(limit)
                .Select(em => new
                {
                    number = em.Number,
                    title = em.Title,
                    type = em.Type.ToString(),
                    timestamp = em.Timestamp.ToString("o")
                })
                .ToArray();

            return new
            {
                success = true,
                categoryId,
                categoryName = cat.LocalizedName,
                count = entries.Length,
                entries
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// List RAPID tasks and modules to support module backup/reset selection.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ListTasks(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            Task[] tasks = controller.Rapid.GetTasks();
            var items = tasks.Select(t => new
            {
                taskName = t.Name,
                executionStatus = t.ExecutionStatus.ToString(),
                modules = t.GetModules().Select(m => m.Name).ToArray()
            }).ToArray();

            return new
            {
                success = true,
                count = items.Length,
                tasks = items
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Backup module to local file
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> BackupModule(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "");
            string preferredTaskName = CoerceString(GetInputValue(input, "taskName"), "");
            string outputDir = CoerceString(GetInputValue(input, "outputDir"), AppDomain.CurrentDomain.BaseDirectory);

            if (!Directory.Exists(outputDir))
            {
                Directory.CreateDirectory(outputDir);
            }

            Task[] tasks = controller.Rapid.GetTasks();
            var orderedTasks = tasks.AsEnumerable();

            if (!string.IsNullOrWhiteSpace(preferredTaskName))
            {
                orderedTasks = orderedTasks
                    .OrderBy(t => string.Equals(t.Name, preferredTaskName, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                    .ThenBy(t => t.Name);
            }

            foreach (Task t in orderedTasks)
            {
                Module module = null;
                if (!string.IsNullOrWhiteSpace(moduleName))
                {
                    module = t.GetModule(moduleName);
                }
                else
                {
                    module = t.GetModules().FirstOrDefault();
                }

                if (module != null)
                {
                    module.SaveToFile(outputDir);
                    return new
                    {
                        success = true,
                        moduleName = module.Name,
                        outputDir,
                        taskName = t.Name
                    };
                }
            }

            return new
            {
                success = false,
                error = "Module not found",
                moduleName,
                preferredTaskName,
                available = tasks.Select(t => new { taskName = t.Name, modules = t.GetModules().Select(m => m.Name).ToArray() }).ToArray()
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.ToString() };
        }
    }

    /// <summary>
    /// Reset task program pointer to main (or a specific module/routine).
    /// If the task has no "main" procedure (e.g. only user modules with custom PROC names),
    /// falls back to SetProgramPointer on the first available user PROC so that
    /// subsequent Start() calls succeed.
    /// Optional params: taskName (default T_ROB1), moduleName, routineName.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ResetProgramPointer(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string taskName    = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");
            string moduleName  = CoerceString(GetInputValue(input, "moduleName"));
            string routineName = CoerceString(GetInputValue(input, "routineName"));

            EnsureRapidControlGrant();
            using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
            {
                Task t = controller.Rapid.GetTask(taskName);

                // If caller explicitly specified a module+routine, use SetProgramPointer directly.
                if (!string.IsNullOrWhiteSpace(moduleName) && !string.IsNullOrWhiteSpace(routineName))
                {
                    t.SetProgramPointer(moduleName, routineName);
                    return new { success = true, taskName = t.Name, moduleName, routineName, method = "SetProgramPointer" };
                }

                // Try the standard ResetPP (requires a "main" procedure in the task).
                bool resetOk = false;
                try
                {
                    t.ResetProgramPointer();
                    resetOk = true;
                }
                catch { /* fall through to SetProgramPointer fallback */ }

                if (resetOk)
                    return new { success = true, taskName = t.Name, method = "ResetProgramPointer" };

                // Fallback: scan user modules for the first PROC and set the pointer there.
                // System modules (user, BASE) are skipped.
                var skipModules = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "user", "BASE" };
                string fallbackModule  = null;
                string fallbackRoutine = null;

                foreach (Module mod in t.GetModules())
                {
                    if (skipModules.Contains(mod.Name)) continue;
                    try
                    {
                        foreach (Routine routine in mod.GetRoutines())
                        {
                            fallbackModule  = mod.Name;
                            fallbackRoutine = routine.Name;
                            break;
                        }
                    }
                    catch { }
                    if (fallbackModule != null) break;
                }

                if (fallbackModule != null)
                {
                    t.SetProgramPointer(fallbackModule, fallbackRoutine);
                    return new
                    {
                        success = true,
                        taskName = t.Name,
                        moduleName  = fallbackModule,
                        routineName = fallbackRoutine,
                        method = "SetProgramPointer_fallback",
                        note   = "No 'main' found; pointer set to first available PROC"
                    };
                }

                return new
                {
                    success = false,
                    taskName,
                    error = "ResetProgramPointer failed and no user PROC found in loaded modules to fall back to. Load a module first or provide moduleName+routineName params."
                };
            }
        }
        catch (Exception ex)
        {
            Task[] tasks;
            try
            {
                tasks = controller?.Rapid?.GetTasks() ?? new Task[0];
            }
            catch
            {
                tasks = new Task[0];
            }
            return new
            {
                success = false,
                error = ex.ToString(),
                availableTasks = tasks.Select(t => t.Name).ToArray()
            };
        }
    }

    /// <summary>
    /// Move robot to joint positions using a dedicated, non-colliding module.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> MoveToJoints(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            double[] joints = CoerceDoubleArray(GetInputValue(input, "joints"));
            double speed = CoerceDouble(GetInputValue(input, "speed"), 100);
            string zone = CoerceString(GetInputValue(input, "zone"), "fine");
            if (joints == null || joints.Length < 6) return new { success = false, error = "Requires joints[6]" };

            string jointsStr = string.Join(", ", joints.Select(j => j.ToString("0.####", CultureInfo.InvariantCulture)));
            string speedStr = FormatSpeedDataLiteral(speed);

            string rapidCode = $@"MODULE OpenClawMotionMod
  LOCAL CONST jointtarget jt := [[{jointsStr}],[9E9,9E9,9E9,9E9,9E9,9E9]];
  LOCAL CONST speeddata spd := {speedStr};
  PROC AgentMoveProc()
    ConfJ \Off;
    ConfL \Off;
    MoveAbsJ jt, spd, {zone}, tool0;
  ENDPROC
ENDMODULE";
            await ExecuteAdhocMotion(rapidCode);
            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Convert Euler angles (degrees) to Quaternion.
    /// </summary>
    private static double[] EulerToQuaternion(double rx, double ry, double rz)
    {
        double radX = rx * Math.PI / 180.0;
        double radY = ry * Math.PI / 180.0;
        double radZ = rz * Math.PI / 180.0;
        double cy = Math.Cos(radZ * 0.5);
        double sy = Math.Sin(radZ * 0.5);
        double cp = Math.Cos(radY * 0.5);
        double sp = Math.Sin(radY * 0.5);
        double cr = Math.Cos(radX * 0.5);
        double sr = Math.Sin(radX * 0.5);

        double w = cr * cp * cy + sr * sp * sy;
        double x = sr * cp * cy - cr * sp * sy;
        double y = cr * sp * cy + sr * cp * sy;
        double z = cr * cp * sy - sr * sp * cy;
        return new[] { w, x, y, z }; // q1, q2, q3, q4
    }

    /// <summary>
    /// Move linear (Cartesian) to target coordinates.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> MoveLinear(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            double x = CoerceDouble(GetInputValue(input, "x"), 0);
            double y = CoerceDouble(GetInputValue(input, "y"), 0);
            double z = CoerceDouble(GetInputValue(input, "z"), 0);
            double rx = CoerceDouble(GetInputValue(input, "rx"), 0);
            double ry = CoerceDouble(GetInputValue(input, "ry"), 0);
            double rz = CoerceDouble(GetInputValue(input, "rz"), 0);
            double speed = CoerceDouble(GetInputValue(input, "speed"), 100);
            string zone = CoerceString(GetInputValue(input, "zone"), "fine");

            var q = EulerToQuaternion(rx, ry, rz);
            string speedStr = FormatSpeedDataLiteral(speed);
            string pos = $"{x.ToString(CultureInfo.InvariantCulture)},{y.ToString(CultureInfo.InvariantCulture)},{z.ToString(CultureInfo.InvariantCulture)}";
            string orient = $"{q[0].ToString("0.####", CultureInfo.InvariantCulture)},{q[1].ToString("0.####", CultureInfo.InvariantCulture)},{q[2].ToString("0.####", CultureInfo.InvariantCulture)},{q[3].ToString("0.####", CultureInfo.InvariantCulture)}";

            string rapidCode = $@"MODULE OpenClawMotionMod
  LOCAL CONST robtarget p1 := [[{pos}],[{orient}],[0,-1,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  LOCAL CONST speeddata spd := {speedStr};
  PROC AgentMoveProc()
    ConfJ \Off;
    ConfL \Off;
    MoveL p1, spd, {zone}, tool0;
  ENDPROC
ENDMODULE";
            await ExecuteAdhocMotion(rapidCode);
            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Move circular. Expects 'circPoint' and 'toPoint' arrays [x,y,z,rx,ry,rz].
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> MoveCircular(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            double[] circ = CoerceDoubleArray(GetInputValue(input, "circPoint"));
            double[] to = CoerceDoubleArray(GetInputValue(input, "toPoint"));
            double speed = CoerceDouble(GetInputValue(input, "speed"), 100);
            string zone = CoerceString(GetInputValue(input, "zone"), "fine");

            if (circ == null || circ.Length < 6 || to == null || to.Length < 6)
                return new { success = false, error = "Requires circPoint[6] and toPoint[6]" };

            var qc = EulerToQuaternion(circ[3], circ[4], circ[5]);
            var qt = EulerToQuaternion(to[3], to[4], to[5]);
            string speedStr = FormatSpeedDataLiteral(speed);

            string posC = $"{circ[0].ToString(CultureInfo.InvariantCulture)},{circ[1].ToString(CultureInfo.InvariantCulture)},{circ[2].ToString(CultureInfo.InvariantCulture)}";
            string oriC = $"{qc[0].ToString("0.####", CultureInfo.InvariantCulture)},{qc[1].ToString("0.####", CultureInfo.InvariantCulture)},{qc[2].ToString("0.####", CultureInfo.InvariantCulture)},{qc[3].ToString("0.####", CultureInfo.InvariantCulture)}";
            string posT = $"{to[0].ToString(CultureInfo.InvariantCulture)},{to[1].ToString(CultureInfo.InvariantCulture)},{to[2].ToString(CultureInfo.InvariantCulture)}";
            string oriT = $"{qt[0].ToString("0.####", CultureInfo.InvariantCulture)},{qt[1].ToString("0.####", CultureInfo.InvariantCulture)},{qt[2].ToString("0.####", CultureInfo.InvariantCulture)},{qt[3].ToString("0.####", CultureInfo.InvariantCulture)}";

            string rapidCode = $@"MODULE OpenClawMotionMod
  LOCAL CONST robtarget pCirc := [[{posC}],[{oriC}],[0,-1,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  LOCAL CONST robtarget pTo := [[{posT}],[{oriT}],[0,-1,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  LOCAL CONST speeddata spd := {speedStr};
  PROC AgentMoveProc()
    ConfJ \Off;
    ConfL \Off;
    MoveC pCirc, pTo, spd, {zone}, tool0;
  ENDPROC
ENDMODULE";
            await ExecuteAdhocMotion(rapidCode);
            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Executes a pure ad-hoc runtime motion without disturbing main() existing procedures.
    /// Requires MODULE OpenClawMotionMod and PROC AgentMoveProc() in the rapidCode.
    /// </summary>
    private async System.Threading.Tasks.Task ExecuteAdhocMotion(string rapidCode)
    {
        Console.WriteLine("---- RAPID CODE DUMP ----\n" + rapidCode + "\n-------------------------");
        EnsureRapidControlAccess(true);
        var task = controller.Rapid.GetTask("T_ROB1");
        string modFileName = "OpenClawMotionMod.mod";
        string tempModFile = Path.Combine(Path.GetTempPath(), modFileName);
        File.WriteAllText(tempModFile, rapidCode);

        var tcs = new TaskCompletionSource<bool>();
        EventHandler<ExecutionStatusChangedEventArgs> statusChangedHandler = (s, e) =>
        {
            if (task.ExecutionStatus == TaskExecutionStatus.Stopped) tcs.TrySetResult(true);
        };

        try
        {
            await System.Threading.Tasks.Task.Run(() =>
            {
                // 路径使用原始 Windows 格式（与 TestConsole 验证过的 ExecuteAdhocMotion 保持一致）
                string remotePath = controller.FileSystem.RemoteDirectory.TrimEnd('/') + "/" + modFileName;
                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        Thread.Sleep(400);
                    }

                    // 步骤 1：重置 PP，防止 PP 锁定模块
                    for (int i = 0; i < 3; i++)
                    {
                        try { task.ResetProgramPointer(); Thread.Sleep(100); break; }
                        catch { Thread.Sleep(100); }
                    }

                    // 步骤 2：无论模块是否在列表中，都尝试删除（SafePutFile 前）
                    try { task.DeleteModule("OpenClawMotionMod"); } catch { }

                    // 步骤 3：模块已从内存移除后，再写入新文件（VFS 不会追加旧内容）
                    SafePutFile(controller, tempModFile, modFileName);

                    // 步骤 4：先尝试 Add，若失败再尝试 Replace
                    bool loaded = task.LoadModuleFromFile(remotePath, RapidLoadMode.Add);
                    if (!loaded)
                        loaded = task.LoadModuleFromFile(remotePath, RapidLoadMode.Replace);
                    if (!loaded)
                    {
                        string errFileName = modFileName.Replace(".mod", ".err");
                        string tempErrFile = Path.Combine(Path.GetTempPath(), errFileName);
                        try
                        {
                            SafeGetFile(controller, tempErrFile, errFileName);
                            string errContent = File.ReadAllText(tempErrFile);
                            throw new InvalidOperationException("Failed to load motion module. Syntax Errors:\n" + errContent);
                        }
                        catch (Exception ex) when (!(ex is InvalidOperationException))
                        {
                            throw new InvalidOperationException("Failed to load motion module. No RAPID syntax errors found. Recent controller events indicate a state issue (e.g., prior socket error stopped RAPID). Original: " + ex.Message);
                        }
                    }
                    task.SetProgramPointer("OpenClawMotionMod", "AgentMoveProc");
                }
            });
            controller.Rapid.ExecutionStatusChanged += statusChangedHandler;
            await System.Threading.Tasks.Task.Run(() =>
            {
                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    StartResult result = controller.Rapid.Start(RegainMode.Continue, ExecutionMode.Continuous, ExecutionCycle.Once);
                    if (result != StartResult.Ok) result = controller.Rapid.Start(RegainMode.Regain, ExecutionMode.Continuous, ExecutionCycle.Once);
                    if (result != StartResult.Ok) throw new InvalidOperationException($"RAPID start failed: {result}");
                }
            });
            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60)))
            {
                cts.Token.Register(() => tcs.TrySetCanceled());
                await tcs.Task;
            }
        }
        finally
        {
            controller.Rapid.ExecutionStatusChanged -= statusChangedHandler;
            TryDeleteTempFile(tempModFile);
            try { controller.FileSystem.RemoveFile(modFileName); } catch { }
            // 关键修复：重置 PP 并卸载模块，防止 PP 残留在 OpenClawMotionMod 内部
            // 导致下次加载时 DeleteModule/Replace 失败（这是 "No .err file found" 错误的根因）。
            try
            {
                await System.Threading.Tasks.Task.Run(() =>
                {
                    try
                    {
                        using (Mastership cleanup = RequestMastershipWithRetry(controller.Rapid))
                        {
                            var t = controller.Rapid.GetTask("T_ROB1");
                            try { t.ResetProgramPointer(); Thread.Sleep(100); } catch { }
                            try { t.DeleteModule("OpenClawMotionMod"); } catch { }
                        }
                    }
                    catch { }
                });
            }
            catch { }
        }
    }

    /// <summary>
    /// Event-driven RAPID execution using LoadModuleFromFile + SetProgramPointer.
    /// Flow: upload module -> Replace/Add load -> SetPP -> start -> wait for Stop.
    /// Avoids LoadProgramFromFile(Replace) which fails on VCs with pre-existing syntax errors.
    /// </summary>
    private async System.Threading.Tasks.Task ExecuteRapidProgramWait(string rapidCode, string moduleName)
    {
        rapidCode = NormalizeRapidSpeedSymbols(rapidCode);
        EnsureRapidControlAccess(true);

        var task = controller.Rapid.GetTask("T_ROB1");

        string targetModuleName = "OpenClawMotionMod";
        string normalizedCode = RenameModuleInCode(rapidCode, targetModuleName);
        
        // Determine the entry routine: use the first PROC found in user code
        string startRoutine = "main";
        Match procMatch = Regex.Match(normalizedCode, @"(?i)PROC\s+([a-zA-Z0-9_]+)");
        if (procMatch.Success)
        {
            startRoutine = procMatch.Groups[1].Value;
        }
        // No need to inject PROC main() — we use SetProgramPointer to start the specific routine

        string modFileName = targetModuleName + ".mod";
        string tempModFile = Path.Combine(Path.GetTempPath(), modFileName);
        File.WriteAllText(tempModFile, normalizedCode);

        var tcs = new TaskCompletionSource<bool>();
        EventHandler<ExecutionStatusChangedEventArgs> statusChangedHandler = null;
        statusChangedHandler = (sender, e) =>
        {
            if (task.ExecutionStatus == TaskExecutionStatus.Stopped)
                tcs.TrySetResult(true);
        };

        try
        {
            await System.Threading.Tasks.Task.Run(() =>
            {
                // Use full remote path (same format that works in LoadRapidProgram)
                string remotePath = controller.FileSystem.RemoteDirectory.TrimEnd('/') + "/" + modFileName;

                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        Thread.Sleep(400);
                    }

                    // Reset PP to prevent module lock (ignore errors)
                    for (int i = 0; i < 3; i++)
                    {
                        try { task.ResetProgramPointer(); Thread.Sleep(100); break; }
                        catch { Thread.Sleep(100); }
                    }

                    // Delete ALL user modules (including ABBVC) to clear semantic errors
                    // from previously deleted/corrupted modules. Keep only system modules.
                    var keepModules = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                        { "user", "BASE" };
                    foreach (Module oldMod in task.GetModules())
                    {
                        if (keepModules.Contains(oldMod.Name)) continue;
                        try { task.DeleteModule(oldMod.Name); } catch { }
                    }

                    SafePutFile(controller, tempModFile, modFileName);

                    // Try Add first (works when module was successfully deleted).
                    // If it fails, the VC file-watcher may have auto-reloaded —
                    // in that case Replace updates the already-loaded module.
                    bool loaded = false;
                    try { loaded = task.LoadModuleFromFile(remotePath, RapidLoadMode.Add); } catch { }
                    if (!loaded)
                    {
                        try { loaded = task.LoadModuleFromFile(remotePath, RapidLoadMode.Replace); } catch { }
                    }
                    // Last resort: VC file-watcher auto-loaded it — verify via GetModules
                    if (!loaded)
                    {
                        Thread.Sleep(500);
                        try
                        {
                            loaded = task.GetModules().Any(mod =>
                                string.Equals(mod.Name, targetModuleName, StringComparison.OrdinalIgnoreCase));
                        }
                        catch { }
                    }
                    if (!loaded)
                        throw new InvalidOperationException($"Failed to load module {targetModuleName}.");

                    task.SetProgramPointer(targetModuleName, startRoutine);
                }
            });

            controller.Rapid.ExecutionStatusChanged += statusChangedHandler;

            await System.Threading.Tasks.Task.Run(() =>
            {
                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    StartResult result = controller.Rapid.Start(
                        RegainMode.Continue, ExecutionMode.Continuous, ExecutionCycle.Once);
                    if (result != StartResult.Ok)
                        result = controller.Rapid.Start(
                            RegainMode.Regain, ExecutionMode.Continuous, ExecutionCycle.Once);
                    if (result != StartResult.Ok)
                        throw new InvalidOperationException($"RAPID start failed: {result}");
                }
                if (task.ExecutionStatus == TaskExecutionStatus.Stopped)
                    tcs.TrySetResult(true);
            });

            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60)))
            using (cts.Token.Register(() => tcs.TrySetCanceled()))
            {
                await tcs.Task;
            }
        }
        finally
        {
            controller.Rapid.ExecutionStatusChanged -= statusChangedHandler;
            TryDeleteTempFile(tempModFile);
            // OpenClawMotionMod stays on the controller — no cleanup needed
        }
    }

    /// <summary>
    /// Rename the MODULE declaration in RAPID code to a new name.
    /// </summary>
    private static string RenameModuleInCode(string code, string newModuleName)
    {
        // Replace MODULE <anything> with MODULE <newName>
        return Regex.Replace(code.TrimStart(),
            @"(?i)^MODULE\s+\w+",
            "MODULE " + newModuleName,
            RegexOptions.Multiline);
    }

    /// <summary>
    /// Execute RAPID program end-to-end (load + reset pointer + start + wait).
    /// This is the recommended high-level entry point for agent-driven motion.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ExecuteRapidProgram(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string code = CoerceString(GetInputValue(input, "code"));
            if (string.IsNullOrWhiteSpace(code))
                code = CoerceString(GetInputValue(input, "rapid_code"));
            if (string.IsNullOrWhiteSpace(code))
                return new { success = false, error = "code (or rapid_code) parameter is required" };

            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "OpenClawMotionMod");
            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), true);

            await ExecuteRapidProgramWait(code, moduleName);
            return new { success = true, moduleName };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Set motors ON or OFF.
    /// Note: PCSDK 2025 DefaultUser does not support motor state toggling via API.
    /// Returns a clear error; toggle motors from the controller pendant or FlexPendant.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> SetMotors(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            string state = CoerceString(GetInputValue(input, "state"), "ON").Trim().ToUpperInvariant();
            // PCSDK 2025 does not expose motor on/off via DefaultUser credentials.
            // Return a descriptive error so agents know to use pendant/FlexPendant.
            return new
            {
                success = false,
                error = "SetMotors is not supported via PC SDK DefaultUser credentials. Toggle motor state from the controller pendant or FlexPendant.",
                requestedState = state,
                motorState = controller.State.ToString()
            };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }



    private static string FormatSpeedDataLiteral(double speed)
    {
        // Use an explicit speeddata literal to avoid invalid predefined names like v8/v12.
        double tcp = Math.Max(1.0, Math.Min(7000.0, speed));
        return "[" + tcp.ToString("0.###", CultureInfo.InvariantCulture) + ",500,5000,1000]";
    }

    private static string NormalizeRapidSpeedSymbols(string rapidCode)
    {
        if (string.IsNullOrWhiteSpace(rapidCode)) return rapidCode;
        return Regex.Replace(rapidCode, @",\s*v(\d+(?:\.\d+)?)\s*,", m =>
        {
            if (!double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var speed))
                return m.Value;
            return ", " + FormatSpeedDataLiteral(speed) + ",";
        }, RegexOptions.IgnoreCase);
    }

    private static object GetInputValue(dynamic input, string key)
    {
        if (input == null || string.IsNullOrWhiteSpace(key)) return null;

        if (input is IDictionary<string, object> dictStr && dictStr.TryGetValue(key, out object val))
            return val;

        if (input is IDictionary dict)
        {
            foreach (DictionaryEntry entry in dict)
                if (string.Equals(entry.Key?.ToString(), key, StringComparison.OrdinalIgnoreCase)) return entry.Value;
        }

        var type = input.GetType();
        var clrProp = type.GetProperty(key, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);
        if (clrProp != null) return clrProp.GetValue(input, null);
        return null;
    }

    private static string CoerceString(object value, string defaultValue = "")
    {
        if (value == null) return defaultValue;
        string s = value.ToString();
        return string.IsNullOrWhiteSpace(s) ? defaultValue : s;
    }

    private static double CoerceDouble(object value, double defaultValue)
    {
        if (value == null) return defaultValue;
        if (value is double d) return d;
        if (value is float f) return f;
        if (value is int i) return i;
        if (value is long l) return l;
        if (double.TryParse(value.ToString(), out var parsed)) return parsed;
        return defaultValue;
    }

    private static bool CoerceBool(object value, bool defaultValue)
    {
        if (value == null) return defaultValue;
        if (value is bool b) return b;
        if (bool.TryParse(value.ToString(), out var parsed)) return parsed;
        return defaultValue;
    }

    private static double[] CoerceDoubleArray(object value)
    {
        if (value == null) return null;
        if (value is double[] dArr) return dArr;

        if (value is IEnumerable seq)
        {
            var list = new System.Collections.Generic.List<double>();
            foreach (var item in seq)
            {
                if (item == null) continue;
                if (double.TryParse(item.ToString(), out var parsed))
                {
                    list.Add(parsed);
                }
            }
            return list.ToArray();
        }

        return null;
    }

    private void EnsureRapidControlGrant()
    {
        if (controller == null)
        {
            throw new InvalidOperationException("Controller is not connected.");
        }

        if (!controller.AuthenticationSystem.CheckDemandGrant(Grant.ExecuteRapid))
        {
            controller.AuthenticationSystem.DemandGrant(Grant.ExecuteRapid);
        }
    }

    private void EnsureRapidControlAccess(bool allowRealExecution)
    {
        if (controller == null)
        {
            throw new InvalidOperationException("Controller is not connected.");
        }

        if (controller.IsVirtual == false && !allowRealExecution)
        {
            throw new InvalidOperationException("Real robot execution blocked by default. Set allowRealExecution=true to continue.");
        }

        if (controller.OperatingMode != ControllerOperatingMode.Auto)
        {
            throw new InvalidOperationException("Controller must be in Auto mode for RAPID operations.");
        }

        if (controller.State != ControllerState.MotorsOn)
        {
            throw new InvalidOperationException("Controller motors must be ON for motion operations.");
        }

        EnsureRapidControlGrant();
    }


    private static string CreateTempRapidFile(string rapidCode, string moduleName, out string fileName)
    {
        string safeModuleName = string.IsNullOrWhiteSpace(moduleName) ? "OpenClawMotionMod" : moduleName;
        fileName = "AgentMod_" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".mod";
        string tempFile = Path.Combine(Path.GetTempPath(), fileName);

        string code = rapidCode ?? string.Empty;
        string content = code.TrimStart().StartsWith("MODULE", StringComparison.OrdinalIgnoreCase)
            ? code : $"MODULE {safeModuleName}\r\n{code}\r\nENDMODULE";

        File.WriteAllText(tempFile, content);
        return tempFile;
    }



    private static void TryDeleteTempFile(string filePath)
    {
        try { if (!string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath)) File.Delete(filePath); } catch { }
    }

    private static void SafePutFile(Controller ctrl, string localPath, string remoteFileName,
                                    bool noSleep = false)
    {
        if (ctrl.IsVirtual)
        {
            string home = ctrl.FileSystem.RemoteDirectory.Replace("ctrl:", "");
            string physicalDest = Path.Combine(home, remoteFileName);
            // Use WriteAllBytes for virtual controllers (PutFile path internally builds "ctrl:C:/..."
            // which is an illegal Windows path, causing FileStream to throw).
            // NOTE: when the module is still in memory, ABB's filesystem watcher will append the
            // in-memory content during the sleep → two-module file. Always delete the module from
            // T_ROB1 memory BEFORE calling SafePutFile so there is nothing to sync back.
            File.WriteAllBytes(physicalDest, File.ReadAllBytes(localPath));
            if (!noSleep) Thread.Sleep(300);
            return;
        }
        ctrl.FileSystem.PutFile(localPath, remoteFileName, true);
        if (!noSleep) Thread.Sleep(300);
    }

    private static void SafeGetFile(Controller ctrl, string localPath, string remoteFileName)
    {
        if (ctrl.IsVirtual)
        {
            try
            {
                string home = ctrl.FileSystem.RemoteDirectory.Replace("ctrl:", "");
                string physicalSource = Path.Combine(home, remoteFileName);
                if (File.Exists(physicalSource))
                {
                    if (File.Exists(localPath)) File.Delete(localPath);
                    File.Copy(physicalSource, localPath);
                    return;
                }
            }
            catch { }
        }
        ctrl.FileSystem.GetFile(remoteFileName, localPath);
    }


    /// <summary>

    /// Read a RAPID variable value from the specified task and module.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> GetRapidVariable(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string taskName = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");

            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "");

            string varName = CoerceString(GetInputValue(input, "varName"), "");

            if (string.IsNullOrWhiteSpace(varName))

                return new { success = false, error = "varName is required" };



            var task = controller.Rapid.GetTask(taskName);

            RapidData rd = string.IsNullOrWhiteSpace(moduleName)

                ? task.GetRapidData(varName)

                : task.GetRapidData(moduleName, varName);



            if (rd == null)

                return new { success = false, error = $"Variable '{varName}' not found in task '{taskName}'" };



            return new { success = true, taskName, moduleName, varName, value = rd.Value.ToString(), dataType = rd.RapidType };

        }

        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }

    }



    /// <summary>

    /// Set a RAPID variable value in the specified task and module.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> SetRapidVariable(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string taskName = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");

            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "");

            string varName = CoerceString(GetInputValue(input, "varName"), "");

            string value = CoerceString(GetInputValue(input, "value"), "");

            if (string.IsNullOrWhiteSpace(varName)) return new { success = false, error = "varName is required" };

            if (string.IsNullOrWhiteSpace(value)) return new { success = false, error = "value is required" };



            var task = controller.Rapid.GetTask(taskName);

            RapidData rd = string.IsNullOrWhiteSpace(moduleName)

                ? task.GetRapidData(varName)

                : task.GetRapidData(moduleName, varName);



            if (rd == null)

                return new { success = false, error = $"Variable '{varName}' not found" };











            using (Mastership m = RequestMastershipWithRetry(controller.Rapid)) { rd.StringValue = value; }









            return new { success = true, taskName, moduleName, varName, value };

        }

        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }

    }



    /// <summary>

    /// Get all IO signals from the controller IOSystem.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> GetIOSignals(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string nameFilter = CoerceString(GetInputValue(input, "nameFilter"), "");

            int limit = (int)Math.Max(1, Math.Min(500, CoerceDouble(GetInputValue(input, "limit"), 100)));



            var signals = await System.Threading.Tasks.Task.Run(() =>

            {

                var result = new System.Collections.Generic.List<object>();

                foreach (ABB.Robotics.Controllers.IOSystemDomain.Signal sig in controller.IOSystem.GetSignals(ABB.Robotics.Controllers.IOSystemDomain.IOFilterTypes.All))

                {

                    if (!string.IsNullOrWhiteSpace(nameFilter) &&

                        sig.Name.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) < 0)

                        continue;

                    result.Add(new

                    {

                        name = sig.Name,

                        type = sig.Type.ToString(),

                        value = sig.State.Value.ToString(),

                        unit = sig.Unit ?? ""

                    });

                    if (result.Count >= limit) break;

                }

                return result;

            });



            return new { success = true, count = signals.Count, signals };

        }

        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }

    }



    /// <summary>

    /// Set a digital IO signal value.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> SetIOSignal(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string signalName = CoerceString(GetInputValue(input, "signalName"), "");

            string value = CoerceString(GetInputValue(input, "value"), "0");

            if (string.IsNullOrWhiteSpace(signalName))

                return new { success = false, error = "signalName is required" };



            ABB.Robotics.Controllers.IOSystemDomain.Signal sig = controller.IOSystem.GetSignal(signalName);

            if (sig == null)

                return new { success = false, error = $"Signal '{signalName}' not found" };











            double numVal; if (!double.TryParse(value, out numVal)) numVal = value == "1" || value.ToLower() == "true" ? 1.0 : 0.0;
            sig.Value = (float)numVal;





            return new { success = true, signalName, value };

        }

        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }

    }



    /// <summary>

    /// Get all event log categories and entry counts.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> GetEventLogCategories(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            var categories = new System.Collections.Generic.List<object>();

            // Standard ABB event log categories: 0=Common,1=Operational,2=System,3=HW,4=Program,5=Motion

            for (int catId = 0; catId <= 5; catId++)

            {

                try

                {

                    EventLogCategory cat = controller.EventLog.GetCategory(catId);

                    if (cat != null)

                    {

                        categories.Add(new { categoryId = catId, name = cat.LocalizedName, count = cat.Messages.Count });

                    }

                }

                catch { }

            }

            return new { success = true, categories };

        }

        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }

    }



    /// <summary>
    /// List RAPID variables in a task/module.
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ListRapidVariables(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            string taskName = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");
            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "");
            int limit = (int)Math.Max(1, Math.Min(500, CoerceDouble(GetInputValue(input, "limit"), 100)));

            var task = controller.Rapid.GetTask(taskName);
            var variables = new System.Collections.Generic.List<object>();

            var searchProps = RapidSymbolSearchProperties.CreateDefault();
            searchProps.Types = SymbolTypes.Constant | SymbolTypes.Variable | SymbolTypes.Persistent;

            RapidSymbol[] syms = null;
            if (string.IsNullOrWhiteSpace(moduleName))
            {
                syms = task.SearchRapidSymbol(searchProps);
            }
            else
            {
                var mod = task.GetModule(moduleName);
                if (mod != null) syms = mod.SearchRapidSymbol(searchProps);
            }

            if (syms != null)
            {
                foreach (RapidSymbol sym in syms)
                {
                    try
                    {
                        var rd = string.IsNullOrWhiteSpace(moduleName) ? task.GetRapidData(sym.Name) : task.GetRapidData(moduleName, sym.Name);
                        variables.Add(new { name = sym.Name, rapidType = rd?.RapidType, value = rd?.Value?.ToString() });
                    }
                    catch
                    {
                        variables.Add(new { name = sym.Name });
                    }
                    if (variables.Count >= limit) break;
                }
            }

            return new { success = true, taskName, count = variables.Count, variables };
        }
        catch (Exception ex) { return new { success = false, error = ex.ToString() }; }
    }

    /// <summary>
    /// Request mastership with retry loop 鈥?RobotStudio virtual controllers periodically hold mastership.
    /// Retries up to maxAttempts times with delayMs between attempts.
    /// </summary>
    private static Mastership RequestMastershipWithRetry(ABB.Robotics.Controllers.IMastershipResource resource, int maxAttempts = 20, int delayMs = 300)
    {
        Exception lastEx = null;
        for (int i = 0; i < maxAttempts; i++)
        {
            try { return Mastership.Request(resource); }
            catch (Exception ex)
            {
                lastEx = ex;
                Thread.Sleep(delayMs);
            }
        }
        throw new InvalidOperationException(
            $"Cannot acquire mastership after {maxAttempts} attempts ({maxAttempts * delayMs / 1000.0:F1}s). " +
            "If RobotStudio is open, click Request Write Access in the RAPID editor, or close RobotStudio FlexPendant view. " +
            $"Last error: {lastEx?.Message}");
    }
}
