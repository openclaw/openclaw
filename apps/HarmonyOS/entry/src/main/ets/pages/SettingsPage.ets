import { MainViewModel } from '../viewmodel/MainViewModel';
import { LocationMode } from '../common/SecurePrefs';

@Component
export struct SettingsPage {
  @ObjectLink viewModel: MainViewModel;
  @StorageProp('localeVersion') localeVersion: number = 0;

  @State displayName: string = '';
  @State cameraEnabled: boolean = false;
  @State locationMode: string = 'off';
  @State locationPrecise: boolean = false;
  @State preventSleep: boolean = false;
  @State micEnabled: boolean = false;
  @State speakerEnabled: boolean = false;
  @State manualEnabled: boolean = false;
  @State manualHost: string = '';
  @State manualPort: string = '18789';
  @State manualTls: boolean = false;
  @State canvasDebugStatus: boolean = false;
  @State appVersion: string = '2026.3.2';

  aboutToAppear(): void {
    this.loadSettings();
  }

  private loadSettings(): void {
    this.displayName = this.viewModel.displayName;
    this.cameraEnabled = this.viewModel.cameraEnabled;
    this.locationMode = this.viewModel.locationMode;
    this.locationPrecise = this.viewModel.locationPreciseEnabled;
    this.preventSleep = this.viewModel.preventSleep;
    this.micEnabled = this.viewModel.micEnabled;
    this.speakerEnabled = this.viewModel.speakerEnabled;
    this.manualEnabled = this.viewModel.manualEnabled;
    this.manualHost = this.viewModel.manualHost;
    this.manualPort = this.viewModel.manualPort > 0 ? this.viewModel.manualPort.toString() : '18789';
    this.manualTls = this.viewModel.manualTls;
    this.canvasDebugStatus = this.viewModel.canvasDebugStatusEnabled;
  }

  build() {
    Scroll() {
      Column({ space: 14 }) {
        this.Header();
        this.NodeSection();
        this.VoiceSection();
        this.CameraSection();
        this.LocationSection();
        this.GatewaySection();
        this.AdvancedSection();
        this.AboutSection();
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 16, bottom: 24 });
    }
    .width('100%')
    .height('100%');
  }

  @Builder Header() {
    Column({ space: 6 }) {
      Text(this.localizedText('settings_header_eyebrow', 'SETTINGS'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Text(this.localizedText('settings_header_title', 'Device Configuration'))
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17181C');

      Text(this.localizedText('settings_header_subtitle', 'Manage capabilities, permissions, diagnostics, and gateway defaults.'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder NodeSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_node', 'NODE'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        Text(this.localizedText('settings_display_name', 'Display name'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');

        TextInput({ placeholder: this.localizedText('settings_display_name_placeholder', 'Device Name'), text: this.displayName })
          .width('100%')
          .height(50)
          .backgroundColor('#F6F7FA')
          .borderColor('#E5E7EC')
          .borderWidth(1)
          .borderRadius(14)
          .padding({ left: 12, right: 12 })
          .fontSize(14)
          .fontColor('#17181C')
          .onChange((value: string) => {
            this.displayName = value;
            void this.viewModel.setDisplayName(value);
          });

        this.InfoRow(this.localizedText('settings_instance_id', 'Instance ID'), this.instanceIdText());
        this.DividerLine();
        this.InfoRow(this.localizedText('settings_status', 'Status'), this.viewModel.statusText || this.localizedText('chat_offline', 'Offline'));
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder VoiceSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_voice', 'VOICE'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        this.SettingToggle(this.localizedText('settings_enable_microphone', 'Enable microphone'), this.localizedText('settings_enable_microphone_desc', 'Allow voice capture and transcripts.'), this.micEnabled, (value: boolean) => {
          this.micEnabled = value;
          void this.viewModel.setMicEnabled(value);
        });
        this.DividerLine();
        this.SettingToggle(this.localizedText('settings_enable_speaker', 'Enable speaker'), this.localizedText('settings_enable_speaker_desc', 'Allow spoken responses and audio output.'), this.speakerEnabled, (value: boolean) => {
          this.speakerEnabled = value;
          void this.viewModel.setSpeakerEnabled(value);
        });
        this.DividerLine();
        this.InfoRow(this.localizedText('settings_mic_status', 'Mic status'), this.viewModel.micStatusText || this.localizedText('settings_off', 'Off'));
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder CameraSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_camera', 'CAMERA'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        this.SettingToggle(this.localizedText('settings_enable_camera', 'Enable camera'), this.localizedText('settings_enable_camera_desc', 'Allow camera access for photos and video tools.'), this.cameraEnabled, (value: boolean) => {
          this.cameraEnabled = value;
          void this.viewModel.setCameraEnabled(value);
        });
        this.DividerLine();
        this.SettingToggle(this.localizedText('settings_prevent_sleep', 'Prevent sleep'), this.localizedText('settings_prevent_sleep_desc', 'Keep the screen awake during active sessions.'), this.preventSleep, (value: boolean) => {
          this.preventSleep = value;
          void this.viewModel.setPreventSleep(value);
        });
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder LocationSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_location', 'LOCATION'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        Row() {
          Column({ space: 2 }) {
            Text(this.localizedText('settings_location_mode', 'Location mode'))
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor('#17181C');

            Text(this.localizedText('settings_location_mode_desc', 'Choose the default location detail available to the gateway.'))
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .fontColor('#8A92A2');
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1);

          Text(this.getLocationModeText())
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor('#1D5DD8');
        }
        .width('100%');

        Row() {
          this.LocationModeChip(this.localizedText('settings_location_mode_off', 'Off'), 0);
          this.LocationModeChip(this.localizedText('settings_location_mode_approx', 'Approx'), 1);
          this.LocationModeChip(this.localizedText('settings_location_mode_precise', 'Precise'), 2);
        }
        .width('100%');

        if (this.locationMode !== 'off') {
          this.DividerLine();
          this.SettingToggle(this.localizedText('settings_precise_location_switch', 'Precise location switch'), this.localizedText('settings_precise_location_switch_desc', 'Enable the precise location preference flag.'), this.locationPrecise, (value: boolean) => {
            this.locationPrecise = value;
            void this.viewModel.setLocationPreciseEnabled(value);
          });
        }
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder GatewaySection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_gateway', 'GATEWAY'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        this.SettingToggle(this.localizedText('settings_manual_mode', 'Manual mode'), this.localizedText('settings_manual_mode_desc', 'Use saved host, port, and TLS defaults for connections.'), this.manualEnabled, (value: boolean) => {
          this.manualEnabled = value;
          void this.viewModel.setManualEnabled(value);
        });

        if (this.manualEnabled) {
          this.DividerLine();

          Text($r('app.string.connect_host'))
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor('#4D5563');

          TextInput({ placeholder: '10.0.2.2', text: this.manualHost })
            .width('100%')
            .height(50)
            .backgroundColor('#F6F7FA')
            .borderColor('#E5E7EC')
            .borderWidth(1)
            .borderRadius(14)
            .padding({ left: 12, right: 12 })
            .fontSize(14)
            .fontColor('#17181C')
            .onChange((value: string) => {
              this.manualHost = value;
              void this.viewModel.setManualHost(value);
            });

            Text($r('app.string.connect_port'))
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor('#4D5563');

          TextInput({ placeholder: '18789', text: this.manualPort })
            .width('100%')
            .height(50)
            .backgroundColor('#F6F7FA')
            .borderColor('#E5E7EC')
            .borderWidth(1)
            .borderRadius(14)
            .padding({ left: 12, right: 12 })
            .fontSize(14)
            .fontColor('#17181C')
            .type(InputType.Number)
            .onChange((value: string) => {
              this.manualPort = value;
              void this.viewModel.setManualPort(parseInt(value, 10) || 0);
            });

          this.SettingToggle(this.localizedText('connect_use_tls', 'Use TLS'), this.localizedText('settings_use_tls_desc', 'Prefer secure websocket (wss) for the manual endpoint.'), this.manualTls, (value: boolean) => {
            this.manualTls = value;
            void this.viewModel.setManualTls(value);
          });
        }
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder AdvancedSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_advanced', 'ADVANCED'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        this.SettingToggle(this.localizedText('settings_canvas_debug_status', 'Canvas debug status'), this.localizedText('settings_canvas_debug_status_desc', 'Show debug status for canvas restore and hydration.'), this.canvasDebugStatus, (value: boolean) => {
          this.canvasDebugStatus = value;
          void this.viewModel.setCanvasDebugStatusEnabled(value);
        });
        this.DividerLine();
        Button({ type: ButtonType.Normal }) {
          Text($r('app.string.connect_run_onboarding_again'))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor('#1D5DD8');
        }
        .width('100%')
        .height(44)
        .backgroundColor('#ECF3FF')
        .borderRadius(12)
        .onClick(() => {
          void this.viewModel.setOnboardingCompleted(false);
        });
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder AboutSection() {
    Column({ space: 12 }) {
      Text(this.localizedText('settings_section_about', 'ABOUT'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Column({ space: 12 }) {
        this.InfoRow(this.localizedText('settings_version', 'Version'), this.appVersion);
        this.DividerLine();
        this.InfoRow(this.localizedText('settings_product', 'Product'), this.localizedText('settings_product_name', 'OpenClaw Mobile for HarmonyOS'));
        this.DividerLine();
        this.InfoRow(this.localizedText('settings_connection', 'Connection'), this.viewModel.isConnected ? this.localizedText('chat_connected', 'Connected') : this.localizedText('chat_offline', 'Offline'));
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 14, bottom: 14 })
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .border({ width: 1, color: '#E5E7EC' });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder SettingToggle(title: string, description: string, isOn: boolean, onChange: (value: boolean) => void) {
    Row() {
      Column({ space: 2 }) {
        Text(title)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#17181C');

        Text(description)
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8A92A2');
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Toggle({ type: ToggleType.Switch, isOn: isOn })
        .selectedColor('#1D5DD8')
        .onChange((value: boolean) => {
          onChange(value);
        });
    }
    .width('100%');
  }

  @Builder InfoRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#17181C');

      Blank();

      Text(value)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#8A92A2')
        .maxLines(1);
    }
    .width('100%');
  }

  @Builder DividerLine() {
    Divider().color('#E5E7EC');
  }

  private isActiveLocationMode(index: number): boolean {
    return this.locationMode === this.locationModeValues()[index];
  }

  @Builder LocationModeChip(label: string, index: number) {
    Button({ type: ButtonType.Normal }) {
      Text(label)
        .fontSize(12)
        .fontWeight(this.isActiveLocationMode(index) ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(this.isActiveLocationMode(index) ? '#FFFFFF' : '#4D5563');
    }
    .height(34)
    .backgroundColor(this.isActiveLocationMode(index) ? '#1D5DD8' : '#F6F7FA')
    .borderRadius(10)
    .border({ width: 1, color: this.isActiveLocationMode(index) ? '#184DAF' : '#D6DAE2' })
    .padding({ left: 12, right: 12 })
    .margin({ right: 8 })
    .onClick(() => {
      this.onLocationModeItemClick(index);
    });
  }

  private instanceIdText(): string {
    return this.viewModel.instanceId && this.viewModel.instanceId.length > 0 ? `${this.viewModel.instanceId.substring(0, 8)}...` : this.localizedText('settings_unavailable', 'Unavailable');
  }

  private getLocationModeText(): string {
    switch (this.locationMode) {
      case 'off':
        return this.localizedText('settings_location_mode_off', 'Off');
      case 'approximate':
        return this.localizedText('settings_location_mode_approximate', 'Approximate');
      case 'precise':
        return this.localizedText('settings_location_mode_precise', 'Precise');
      default:
        return this.localizedText('settings_location_mode_off', 'Off');
    }
  }

  private locationModeValues(): string[] {
    return ['off', 'approximate', 'precise'];
  }

  private onLocationModeItemClick(index: number): void {
    const modes: LocationMode[] = [
      LocationMode.Off,
      LocationMode.Approximate,
      LocationMode.Precise
    ];
    const selected: LocationMode = index >= 0 && index < modes.length ? modes[index] : LocationMode.Off;
    this.locationMode = selected;
    void this.viewModel.setLocationMode(selected);
  }

  private localizedText(name: string, fallback: string): string {
    try {
      void this.localeVersion;
      return getContext(this).resourceManager.getStringByNameSync(name);
    } catch (error) {
      console.warn('SettingsPage: localizedText failed for key: ' + name);
      return fallback;
    }
  }
}
