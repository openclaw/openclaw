; OpenClaw Windows Installer Script (Inno Setup)
; 中文安装界面，支持服务安装/开机自启

#define MyAppName "OpenClaw"
#define MyAppVersion "2026.2.27"
#define MyAppPublisher "OpenClaw"
#define MyAppURL "https://openclaw.ai"
#define MyAppExeName "openclaw.exe"
#define MyAppServiceName "OpenClawGateway"

[Setup]
; 基础配置
AppId={{8F7D9A2E-3B4C-5D6E-7F8A-9B0C1D2E3F4A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL=https://github.com/openclaw/openclaw
AppUpdatesURL=https://github.com/openclaw/openclaw/releases
AppIcon=openclaw.ico
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
; 输出配置
OutputDir=..\dist
OutputBaseFilename=OpenClaw-{#MyAppVersion}-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; 管理员权限 (用于服务安装)
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; 64位系统
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 卸载配置
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.CreateDesktopIcon=创建桌面快捷方式(&D)
chinesesimplified.InstallService=安装为 Windows 服务并开机自启(&S)
chinesesimplified.ServiceDescription={#MyAppName} 网关后台服务
chinesesimplified.StartServiceNow=立即启动服务
chinesesimplified.KeepUserData=保留用户数据
chinesesimplified.RemoveUserData=清除所有用户数据
chinesesimplified.ServiceOption=服务选项
chinesesimplified.ShortcutOption=快捷方式

english.CreateDesktopIcon=Create desktop shortcut(&D)
english.InstallService=Install as Windows service with auto-start(&S)
english.ServiceDescription={#MyAppName} Gateway Service
english.StartServiceNow=Start service now
english.KeepUserData=Keep user data
english.RemoveUserData=Remove all user data
english.ServiceOption=Service Options
english.ShortcutOption=Shortcut Options

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:ShortcutOption}"; Flags: unchecked
Name: "service"; Description: "{cm:InstallService}"; GroupDescription: "{cm:ServiceOption}"; Flags: unchecked

[Files]
; 主程序 (dist 目录)
Source: "..\dist\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; WinSW 服务包装器
Source: "..\third_party\winsw\WinSW-x64.exe"; DestDir: "{app}"; DestName: "openclaw-gateway.exe"; Flags: ignoreversion
Source: "..\third_party\winsw\openclaw-gateway.xml"; DestDir: "{app}"; Flags: ignoreversion
; 许可证文件
Source: "..\third_party\winsw\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
; 应用图标
Source: "openclaw.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\third_party\winsw\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Comment: "{cm:ServiceDescription}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 安装完成后可选择启动服务
Filename: "{cmd}"; Parameters: "/c start "" {#MyAppName}"" ""{app}\{#MyAppExeName}"""; StatusMsg: "{cm:StartServiceNow}"; Flags: postinstall skipifsilent

[UninstallRun]
; 卸载时停止并删除服务
Filename: "sc"; Parameters: "stop {#MyAppServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "sc"; Parameters: "delete {#MyAppServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\OpenClaw"
Type: filesandordirs; Name: "{userappdata}\OpenClaw"

[Code]
var
  ServicePage: TWizardPage;
  ServiceCheckBox: TCheckBox;
  DesktopCheckBox: TCheckBox;

procedure InitializeWizard;
begin
  // 服务选项页面
  ServicePage := CreateCustomPage(wpSelectTasks, '服务选项', '配置 OpenClaw 服务安装方式');
  
  ServiceCheckBox := TCheckBox.Create(ServicePage);
  ServiceCheckBox.Parent := ServicePage.Surface;
  ServiceCheckBox.Caption := CustomMessage('InstallService');
  ServiceCheckBox.Left := ScaleX(20);
  ServiceCheckBox.Top := ScaleY(10);
  ServiceCheckBox.Width := ServicePage.SurfaceWidth - ScaleX(40);
  ServiceCheckBox.Height := ScaleY(24);
  ServiceCheckBox.Checked := False;

  DesktopCheckBox := TCheckBox.Create(ServicePage);
  DesktopCheckBox.Parent := ServicePage.Surface;
  DesktopCheckBox.Caption := CustomMessage('CreateDesktopIcon');
  DesktopCheckBox.Left := ScaleX(20);
  DesktopCheckBox.Top := ScaleY(45);
  DesktopCheckBox.Width := ServicePage.SurfaceWidth - ScaleX(40);
  DesktopCheckBox.Height := ScaleY(24);
  DesktopCheckBox.Checked := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if ServiceCheckBox.Checked then
    begin
      // 安装服务
      Exec('cmd', '/c ""{app}\openclaw-gateway.exe" install"', 
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      
      // 启动服务
      Exec('cmd', '/c sc start {#MyAppServiceName}', 
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;
