using System;
using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using ABB.Robotics.Controllers;
using ABB.Robotics.Controllers.Discovery;
using ABB.Robotics.Controllers.EventLogDomain;
using ABB.Robotics.Controllers.MotionDomain;
using ABB.Robotics.Controllers.RapidDomain;

/// <summary>
/// ABB Robot Controller Bridge for PC SDK Integration
/// Provides direct communication with actual ABB robot controllers
/// </summary>
public class ABBBridge
{
    private Controller controller;
    private bool isConnected = false;

    /// <summary>
    /// Connect to ABB robot controller
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

            var scanner = new NetworkScanner();
            scanner.Scan();
            var controllers = scanner.Controllers;

            if (controllers == null || controllers.Count == 0)
            {
                return new { success = false, error = "No ABB controllers discovered by NetScan" };
            }

            string target = host.Trim();
            bool localRequested =
                string.Equals(target, "127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(target, "localhost", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(target, "::1", StringComparison.OrdinalIgnoreCase);

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
                foreach (ControllerInfo info in controllers)
                {
                    if (info.IsVirtual)
                    {
                        selectedInfo = info;
                        break;
                    }
                }
            }

            if (selectedInfo == null)
            {
                var discovered = controllers
                    .Cast<ControllerInfo>()
                    .Select(ci =>
                        (ci.IPAddress?.ToString() ?? "?") +
                        " (Id=" + ci.Id +
                        ", Virtual=" + ci.IsVirtual +
                        ", SystemId=" + ci.SystemId + ")")
                    .ToArray();

                return new
                {
                    success = false,
                    error = "Controller not found in NetScan",
                    requestedHost = target,
                    discoveredControllers = discovered
                };
            }

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
                    serialNumber = controller.SystemId.ToString(),
                    connected = true,
                    host = selectedInfo.IPAddress?.ToString(),
                    isVirtual = selectedInfo.IsVirtual,
                    controllerId = selectedInfo.Id
                };
            }
            else
            {
                return new { success = false, error = "Failed to connect to controller" };
            }
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
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
    /// Scan ABB controllers on network (FormMain Experiment 1 equivalent).
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

            var operationMode = controller.OperatingMode.ToString();
            var controllerState = controller.State.ToString();
            var task = controller.Rapid.GetTask("T_ROB1");
            var taskExecStatus = task.ExecutionStatus.ToString();

            return new
            {
                success = true,
                connected = isConnected,
                operationMode = operationMode,
                motorState = controllerState,
                rapidRunning = task.ExecutionStatus == TaskExecutionStatus.Running,
                rapidExecutionStatus = taskExecStatus
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Get robotware/system metadata (FormMain Experiment 2 equivalent).
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
    /// Get service/runtime info (FormMain Experiment 3 equivalent).
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
    /// Get speed ratio (FormMain Experiment 6 equivalent).
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
    /// Set speed ratio (TrackBar behavior equivalent).
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

            double[] jointArray = new double[6];
            jointArray[0] = robAx.Rax_1;
            jointArray[1] = robAx.Rax_2;
            jointArray[2] = robAx.Rax_3;
            jointArray[3] = robAx.Rax_4;
            jointArray[4] = robAx.Rax_5;
            jointArray[5] = robAx.Rax_6;

            return new { success = true, joints = jointArray };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Get world pose (FormMain Experiment 8 equivalent).
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
    /// Read event log entries (FormMain Experiment 9 equivalent).
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
    /// Backup module to local file (FormMain Experiment 10 equivalent).
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
    /// Reset task program pointer to main (FormMain Experiment 11 equivalent).
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
            using (Mastership m = Mastership.Request(controller.Rapid))
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

            if (joints == null || joints.Length < 6)
            {
                return new { success = false, error = "MoveToJoints requires joints[6]" };
            }

            string rapidCode = GenerateMoveJointsCode(joints, speed, zone);
            await ExecuteRapidProgram(rapidCode, "MainModule");

            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Execute RAPID program
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> ExecuteRapidProgram(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string rapidCode = CoerceString(GetInputValue(input, "code"));
            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "MainModule");
            rapidCode = NormalizeRapidSpeedSymbols(rapidCode);

            await ExecuteRapidProgram(rapidCode, moduleName);

            return new { success = true };
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
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string rapidCode = CoerceString(GetInputValue(input, "code"));
            string moduleName = CoerceString(GetInputValue(input, "moduleName"), "MainModule");
            rapidCode = NormalizeRapidSpeedSymbols(rapidCode);

            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), false);
            EnsureRapidControlAccess(allowRealExecution);

            // Write module to controller HOME directory so it's accessible by the controller filesystem
            string homeDir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "RobotStudio", "Systems", controller.SystemName, "HOME");
            string modFileName = moduleName + ".mod";
            string modFilePath = System.IO.Path.Combine(homeDir, modFileName);
            bool usedHomeDir = false;

            string tempFile = CreateTempRapidFile(rapidCode, moduleName);
            try
            {
                using (Mastership m = Mastership.Request(controller.Rapid))
                {
                    var task = controller.Rapid.GetTask("T_ROB1");

                    // Stop T_ROB1 first if running
                    if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    {
                        controller.Rapid.Stop(StopMode.Immediate);
                        System.Threading.Thread.Sleep(300);
                    }

                    // Delete any leftover temporary modules (not system, not MainModule, not Communicate)
                    foreach (Module mod in task.GetModules())
                    {
                        if (!mod.IsSystem && mod.Name != "MainModule" && mod.Name != "Communicate")
                        {
                            try { task.DeleteModule(mod.Name); } catch { }
                        }
                    }

                    bool loaded = false;

                    // Try writing to HOME directory first (works when com task is running)
                    if (System.IO.Directory.Exists(homeDir))
                    {
                        try
                        {
                            System.IO.File.WriteAllText(modFilePath, rapidCode);
                            loaded = task.LoadModuleFromFile(modFilePath, RapidLoadMode.Replace);
                            usedHomeDir = loaded;
                        }
                        catch { }
                    }

                    // Fall back to LoadProgramFromFile with temp file
                    if (!loaded)
                    {
                        loaded = task.LoadProgramFromFile(tempFile, RapidLoadMode.Replace);
                    }

                    if (!loaded)
                    {
                        return new { success = false, error = "Failed to load RAPID program from temporary file" };
                    }
                }
            }
            finally
            {
                TryDeleteTempFile(tempFile);
                if (!usedHomeDir && System.IO.File.Exists(modFilePath))
                {
                    try { System.IO.File.Delete(modFilePath); } catch { }
                }
            }

            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Start RAPID execution
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> StartRapid(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            bool allowRealExecution = CoerceBool(GetInputValue(input, "allowRealExecution"), false);
            EnsureRapidControlAccess(allowRealExecution);
            using (Mastership m = Mastership.Request(controller.Rapid))
            {
                // Use controller-level Rapid.Start() instead of task.Start().
                // task.Start() returns StartResult.Error when other tasks (e.g. com) are running.
                // controller.Rapid.Start() correctly starts all runnable tasks.
                StartResult result = controller.Rapid.Start(
                    RegainMode.Continue,
                    ExecutionMode.Continuous,
                    ExecutionCycle.Once);
                if (result != StartResult.Ok)
                {
                    return new { success = false, error = $"RAPID start failed: {result}" };
                }
            }

            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Stop RAPID execution
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> StopRapid(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            EnsureRapidControlGrant();
            using (Mastership m = Mastership.Request(controller.Rapid))
            {
                var task = controller.Rapid.GetTask("T_ROB1");
                task.Stop(StopMode.Immediate);
            }

            return new { success = true };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Set motors on/off
    /// </summary>
    public async System.Threading.Tasks.Task<dynamic> SetMotors(dynamic input)
    {
        try
        {
            if (!isConnected || controller == null)
            {
                return new { success = false, error = "Not connected" };
            }

            string state = CoerceString(GetInputValue(input, "state"));
            return new
            {
                success = false,
                error = "MotorOn/MotorOff is not available in ABB PCSDK 2025 controller API",
                requestedState = state
            };
        }
        catch (Exception ex)
        {
            return new { success = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Generate RAPID code for joint movement
    /// </summary>
    private string GenerateMoveJointsCode(double[] joints, double speed, string zone)
    {
        string jointsStr = string.Join(", ", joints);
        string speedStr = FormatSpeedDataLiteral(speed);

        return $@"MODULE MainModule
  PROC main()
    MoveAbsJ [[{jointsStr}], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]], {speedStr}, {zone}, tool0;
  ENDPROC
ENDMODULE";
    }

    private static string FormatSpeedDataLiteral(double speed)
    {
        // Use an explicit speeddata literal to avoid invalid predefined names like v8/v12.
        double tcp = Math.Max(1.0, Math.Min(7000.0, speed));
        string tcpText = tcp.ToString("0.###", CultureInfo.InvariantCulture);
        return "[" + tcpText + ",500,5000,1000]";
    }

    private static string NormalizeRapidSpeedSymbols(string rapidCode)
    {
        if (string.IsNullOrWhiteSpace(rapidCode))
        {
            return rapidCode;
        }

        // Convert legacy speed symbols like ', v8,' to explicit speeddata literals.
        return Regex.Replace(
            rapidCode,
            @",\s*v(\d+(?:\.\d+)?)\s*,",
            m =>
            {
                if (!double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var speed))
                {
                    return m.Value;
                }

                return ", " + FormatSpeedDataLiteral(speed) + ",";
            },
            RegexOptions.IgnoreCase);
    }

    private static object GetInputValue(dynamic input, string key)
    {
        if (input == null || string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        object boxed = input;
        if (boxed is IDictionary dict)
        {
            foreach (DictionaryEntry entry in dict)
            {
                if (entry.Key != null &&
                    string.Equals(entry.Key.ToString(), key, StringComparison.OrdinalIgnoreCase))
                {
                    return entry.Value;
                }
            }
        }

        var type = boxed.GetType();
        var clrProp = type.GetProperty(key,
            System.Reflection.BindingFlags.Public |
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.IgnoreCase);
        if (clrProp != null)
        {
            return clrProp.GetValue(boxed, null);
        }

        // PowerShell PSCustomObject often stores payload fields in a 'Properties' collection.
        var propsProp = type.GetProperty("Properties",
            System.Reflection.BindingFlags.Public |
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.IgnoreCase);
        var propsObj = propsProp?.GetValue(boxed, null) as IEnumerable;
        if (propsObj != null)
        {
            foreach (var p in propsObj)
            {
                if (p == null) continue;
                var pType = p.GetType();
                var name = pType.GetProperty("Name")?.GetValue(p, null)?.ToString();
                if (!string.Equals(name, key, StringComparison.OrdinalIgnoreCase)) continue;
                return pType.GetProperty("Value")?.GetValue(p, null);
            }
        }

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

    /// <summary>
    /// Execute RAPID program internally
    /// </summary>
    private async System.Threading.Tasks.Task ExecuteRapidProgram(string rapidCode, string moduleName)
    {
        rapidCode = NormalizeRapidSpeedSymbols(rapidCode);
        EnsureRapidControlAccess(true);
        var task = controller.Rapid.GetTask("T_ROB1");
        string tempFile = CreateTempRapidFile(rapidCode, moduleName);
        try
        {
            using (Mastership m = Mastership.Request(controller.Rapid))
            {
                bool loaded = task.LoadProgramFromFile(tempFile, RapidLoadMode.Replace);
                if (!loaded)
                {
                    throw new InvalidOperationException("Failed to load RAPID program from temporary file.");
                }

                task.Start();
            }
            var sw = Stopwatch.StartNew();
            while (task.ExecutionStatus == TaskExecutionStatus.Running)
            {
                if (sw.Elapsed > TimeSpan.FromSeconds(30))
                {
                    throw new TimeoutException("RAPID execution timeout (>30s)");
                }
                await System.Threading.Tasks.Task.Delay(100);
            }
        }
        finally
        {
            TryDeleteTempFile(tempFile);
        }
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

    private static string CreateTempRapidFile(string rapidCode, string moduleName)
    {
        string safeModuleName = string.IsNullOrWhiteSpace(moduleName) ? "MainModule" : moduleName;
        string fileName = "ABBBridge_" + safeModuleName + "_" + Guid.NewGuid().ToString("N") + ".prg";
        string tempFile = Path.Combine(Path.GetTempPath(), fileName);
        File.WriteAllText(tempFile, rapidCode ?? string.Empty);
        return tempFile;
    }

    private static void TryDeleteTempFile(string filePath)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
        }
    }
}
