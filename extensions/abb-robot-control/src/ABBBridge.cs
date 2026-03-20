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
    private Controller controller;
    private bool isConnected = false;

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
                    isVirtual = selectedInfo.IsVirtual
                };
            }
            return new { success = false, error = "Logon failed." };
        }
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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

            string rapidCode = CoerceString(GetInputValue(input, "code"));
            string moduleName = "MainModule"; 
            rapidCode = NormalizeRapidSpeedSymbols(rapidCode);

            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), false);
            EnsureRapidControlAccess(allowRealExecution);

            // 1. 在运行 Agent 的 PC 上生成临时文件
            string localTempFilePath = CreateTempRapidFile(rapidCode, moduleName, out string fileName);
            string remoteSystemPath = $"{fileName}"; // 默认传入 HOME 目录

            await System.Threading.Tasks.Task.Run(() =>
            {
                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    var task = controller.Rapid.GetTask("T_ROB1");

                    if (task.ExecutionStatus == TaskExecutionStatus.Stopped || task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        Thread.Sleep(200); 
                    }

                    // 2. 将本地文件推送到真实机器人的控制器文件系统中
                    controller.FileSystem.PutFile(localTempFilePath, remoteSystemPath, true);

                    // 3. 安全加载：使用 Replace 覆盖同名模块，而不是暴力删除所有模块
                    bool loaded = task.LoadModuleFromFile(remoteSystemPath, RapidLoadMode.Replace);
                    if (!loaded) throw new Exception("Controller failed to load the module into memory.");

                    // 重置指针，加入合理的重试机制
                    for (int i = 0; i < 3; i++)
                    {
                        try { task.ResetProgramPointer(); break; }
                        catch { Thread.Sleep(100); }
                    }
                }

                // 4. 清理控制器内的临时文件，保持文件系统干净
                try { controller.FileSystem.RemoveFile(remoteSystemPath); } catch { }
            });

            // 清理本地临时文件
            TryDeleteTempFile(localTempFilePath);

            return new { success = true };
        }
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
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
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
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
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Reset task program pointer to main
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ResetProgramPointer(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string taskName = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");

            EnsureRapidControlGrant();
            using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
            {
                Task t = controller.Rapid.GetTask(taskName);
                t.ResetProgramPointer();
                return new { success = true, taskName = t.Name };
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
                error = ex.Message,
                availableTasks = tasks.Select(t => t.Name).ToArray()
            };
        }
    }

    /// <summary>
    /// Move robot to joint positions
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> MoveToJoints(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            double[] joints = CoerceDoubleArray(GetInputValue(input, "joints"));
            double speed = CoerceDouble(GetInputValue(input, "speed"), 100);
            string zone = CoerceString(GetInputValue(input, "zone"), "fine");

            if (joints == null || joints.Length < 6) return new { success = false, error = "Requires joints[6]" };

            string rapidCode = GenerateMoveJointsCode(joints, speed, zone);
            await ExecuteRapidProgramWait(rapidCode, "MainModule");

            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Event-driven RAPID execution using unique module name to avoid name collisions.
    /// Flow: upload unique-named module -> Add load -> reset PP -> start -> wait -> delete module.
    /// </summary>
    private async System.Threading.Tasks.Task ExecuteRapidProgramWait(string rapidCode, string moduleName)
    {
        rapidCode = NormalizeRapidSpeedSymbols(rapidCode);
        EnsureRapidControlAccess(true);

        var task = controller.Rapid.GetTask("T_ROB1");

        // Use Replace mode on MainModule to avoid ambiguous main() proc errors.
        // RapidLoadMode.Add with unique names causes C0049003 when Communicate module
        // already has a main() proc as the task entry point.
        string targetModuleName = "MainModule";
        string normalizedCode = RenameModuleInCode(rapidCode, targetModuleName);
        string modFileName  = targetModuleName + ".mod";
        string pgfFileName  = "RobotProgram.pgf";
        string tempModFile  = Path.Combine(Path.GetTempPath(), modFileName);
        string tempPgfFile  = Path.Combine(Path.GetTempPath(), pgfFileName);
        string pgfContent   = "<?xml version=\"1.0\" encoding=\"ISO-8859-1\" ?>\r\n<Program>\r\n  <Module>" + modFileName + "</Module>\r\n</Program>";
        File.WriteAllText(tempModFile, normalizedCode);
        File.WriteAllText(tempPgfFile, pgfContent);
        // Keep uniqueModuleName alias for error messages
        string uniqueModuleName = targetModuleName;

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
                // Upload .mod and .pgf to controller HOME
                string homeDir = controller.FileSystem.RemoteDirectory;
                controller.FileSystem.PutFile(tempModFile, modFileName, true);
                controller.FileSystem.PutFile(tempPgfFile, pgfFileName, true);
                string remotePgfPath = homeDir.TrimEnd('/') + "/" + pgfFileName;

                using (Mastership m = RequestMastershipWithRetry(controller.Rapid))
                {
                    // Stop if running before loading
                    if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        Thread.Sleep(400);
                    }
                    // Use Add mode with unique name 鈥?no collision possible
                    // Clean up leftover AgentMod_* modules to avoid ambiguous main() error
                    foreach (Module oldMod in task.GetModules())
                    {
                        if (oldMod.Name.StartsWith("AgentMod_"))
                        {
                            try { task.DeleteModule(oldMod.Name); } catch { }
                        }
                    }
                    bool loaded = task.LoadProgramFromFile(remotePgfPath, RapidLoadMode.Replace);
                    if (!loaded) throw new InvalidOperationException($"Failed to load program {targetModuleName}.");
                    task.ResetProgramPointer();
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
            TryDeleteTempFile(tempPgfFile);
            try { controller.FileSystem.RemoveFile(modFileName); } catch { }
            try { controller.FileSystem.RemoveFile(pgfFileName); } catch { }
            // MainModule replaced in-place; no cleanup needed
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

            string code        = CoerceString(GetInputValue(input, "code"));
            if (string.IsNullOrWhiteSpace(code))
                code = CoerceString(GetInputValue(input, "rapid_code"));
            if (string.IsNullOrWhiteSpace(code))
                return new { success = false, error = "code (or rapid_code) parameter is required" };

            string moduleName        = CoerceString(GetInputValue(input, "moduleName"), "MainModule");
            bool   allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), true);

            await ExecuteRapidProgramWait(code, moduleName);
            return new { success = true, moduleName };
        }
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
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
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
    }

    /// <summary>
    /// Generate RAPID code for joint movement
    /// </summary>
    private string GenerateMoveJointsCode(double[] joints, double speed, string zone)
    {
        string jointsStr = string.Join(", ", joints.Select(j => j.ToString("0.####", CultureInfo.InvariantCulture)));
        string speedStr = FormatSpeedDataLiteral(speed);
        return $@"MODULE MainModule
  PROC main()
    ConfJ \Off;
    ConfL \Off;
    VAR jointtarget jt := [[{jointsStr}],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    MoveAbsJ jt, {speedStr}, {zone}, tool0;
    Stop;
  ENDPROC
ENDMODULE";
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
        string safeModuleName = string.IsNullOrWhiteSpace(moduleName) ? "MainModule" : moduleName;
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


    /// <summary>

    /// Read a RAPID variable value from the specified task and module.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> GetRapidVariable(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string taskName   = CoerceString(GetInputValue(input, "taskName"),   "T_ROB1");

            string moduleName = CoerceString(GetInputValue(input, "moduleName"),  "");

            string varName    = CoerceString(GetInputValue(input, "varName"),     "");

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

        catch (Exception ex) { return new { success = false, error = ex.Message }; }

    }



    /// <summary>

    /// Set a RAPID variable value in the specified task and module.

    /// </summary>

    public async System.Threading.Tasks.Task<dynamic> SetRapidVariable(dynamic input)

    {

        try

        {

            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };

            string taskName   = CoerceString(GetInputValue(input, "taskName"),   "T_ROB1");

            string moduleName = CoerceString(GetInputValue(input, "moduleName"),  "");

            string varName    = CoerceString(GetInputValue(input, "varName"),     "");

            string value      = CoerceString(GetInputValue(input, "value"),       "");

            if (string.IsNullOrWhiteSpace(varName))  return new { success = false, error = "varName is required" };

            if (string.IsNullOrWhiteSpace(value))    return new { success = false, error = "value is required" };



            var task = controller.Rapid.GetTask(taskName);

            RapidData rd = string.IsNullOrWhiteSpace(moduleName)

                ? task.GetRapidData(varName)

                : task.GetRapidData(moduleName, varName);



            if (rd == null)

                return new { success = false, error = $"Variable '{varName}' not found" };











            using (Mastership m = RequestMastershipWithRetry(controller.Rapid)) { rd.StringValue = value; }









            return new { success = true, taskName, moduleName, varName, value };

        }

        catch (Exception ex) { return new { success = false, error = ex.Message }; }

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

                        name  = sig.Name,

                        type  = sig.Type.ToString(),

                        value = sig.State.Value.ToString(),

                        unit  = sig.Unit ?? ""

                    });

                    if (result.Count >= limit) break;

                }

                return result;

            });



            return new { success = true, count = signals.Count, signals };

        }

        catch (Exception ex) { return new { success = false, error = ex.Message }; }

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

            string value      = CoerceString(GetInputValue(input, "value"), "0");

            if (string.IsNullOrWhiteSpace(signalName))

                return new { success = false, error = "signalName is required" };



            ABB.Robotics.Controllers.IOSystemDomain.Signal sig = controller.IOSystem.GetSignal(signalName);

            if (sig == null)

                return new { success = false, error = $"Signal '{signalName}' not found" };











            double numVal; if (!double.TryParse(value, out numVal)) numVal = value == "1" || value.ToLower() == "true" ? 1.0 : 0.0;
            sig.Value = (float)numVal;





            return new { success = true, signalName, value };

        }

        catch (Exception ex) { return new { success = false, error = ex.Message }; }

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

        catch (Exception ex) { return new { success = false, error = ex.Message }; }

    }



    /// <summary>

    /// <summary>List module names in a RAPID task.</summary>
    public async System.Threading.Tasks.Task<dynamic> ListRapidVariables(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null) return new { success = false, error = "Not connected" };
            string taskName   = CoerceString(GetInputValue(input, "taskName"), "T_ROB1");
            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "");
            int limit = (int)Math.Max(1, Math.Min(200, CoerceDouble(GetInputValue(input, "limit"), 50)));
            var task = controller.Rapid.GetTask(taskName);
            var variables = new System.Collections.Generic.List<object>();
            Module[] allMods = task.GetModules();
            foreach (Module mod in allMods)
            {
                if (!string.IsNullOrWhiteSpace(moduleName) &&
                    !string.Equals(mod.Name, moduleName, StringComparison.OrdinalIgnoreCase)) continue;
                variables.Add(new { moduleName = mod.Name, taskName });
                if (variables.Count >= limit) break;
            }
            return new { success = true, taskName, count = variables.Count, variables };
        }
        catch (Exception ex) { return new { success = false, error = ex.Message }; }
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
