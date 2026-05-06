import { MainViewModel } from '../viewmodel/MainViewModel';
import { GatewayEndpoint } from '../model/GatewayModels';

@Component
export struct ConnectPage {
  @ObjectLink viewModel: MainViewModel;
  @StorageProp('localeVersion') localeVersion: number = 0;

  @State inputMode: string = 'SetupCode';
  @State setupCode: string = '';
  @State manualHost: string = '';
  @State manualPort: string = '18789';
  @State manualTls: boolean = false;
  @State gatewayToken: string = '';
  @State gatewayPassword: string = '';
  @State advancedOpen: boolean = false;
  @State validationText: string = '';
  @State connectedState: boolean = false;
  @State statusState: string = '';
  @State remoteAddressState: string = '';
  @State serverNameState: string = '';

  private connectionStateListenerId: number = -1;

  aboutToAppear(): void {
    this.manualHost = this.viewModel.manualHost || '127.0.0.1';
    this.manualPort = this.viewModel.manualPort > 0 ? this.viewModel.manualPort.toString() : '18789';
    this.manualTls = this.viewModel.manualTls;
    this.gatewayToken = this.viewModel.gatewayToken || '';
    this.gatewayPassword = this.viewModel.gatewayPassword || '';
    if (this.viewModel.manualEnabled || this.viewModel.manualHost.trim().length > 0 || this.viewModel.gatewayToken.trim().length > 0) {
      this.inputMode = 'Manual';
    }
    this.syncConnectionState();
    this.connectionStateListenerId = this.viewModel.addConnectionStateListener(() => {
      this.syncConnectionState();
    });
  }

  aboutToDisappear(): void {
    if (this.connectionStateListenerId >= 0) {
      this.viewModel.removeConnectionStateListener(this.connectionStateListenerId);
      this.connectionStateListenerId = -1;
    }
  }

  build() {
    Scroll() {
      Column({ space: 14 }) {
        this.Header();
        this.ActiveEndpointCard();
        this.StatusCard();
        this.PrimaryActionButton();
        this.AdvancedToggle();

        if (this.advancedOpen) {
          this.AdvancedControlsCard();
        }

        if (this.validationText.length > 0) {
          Text(this.validationText)
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor('#C8841A');
        }

        // this.DiscoveredGatewaysCard();
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 8, bottom: 20 });
    }
    .width('100%')
    .height('100%');
  }

  @Builder Header() {
    Column({ space: 6 }) {
      Text($r('app.string.connect_control_eyebrow'))
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');

      Text($r('app.string.connect_title'))
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17181C');

      Text($r('app.string.connect_subtitle'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder ActiveEndpointCard() {
    Column({ space: 4 }) {
      Text($r('app.string.connect_active_endpoint'))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');

      Text(this.activeEndpointText())
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#17181C');
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .backgroundColor('#F6F7FA')
    .borderRadius(14)
    .border({ width: 1, color: '#E5E7EC' });
  }

  @Builder StatusCard() {
    Column({ space: 4 }) {
      Text($r('app.string.connect_gateway_state'))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');

      Text(this.gatewayStateText())
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#17181C');
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .backgroundColor('#F6F7FA')
    .borderRadius(14)
    .border({ width: 1, color: '#E5E7EC' });
  }

  @Builder PrimaryActionButton() {
    Button(this.primaryButtonText())
      .width('100%')
      .height(52)
      .backgroundColor(this.connectedState ? '#DC2626' : '#1D5DD8')
      .borderRadius(14)
      .fontSize(16)
      .fontWeight(FontWeight.Bold)
      .fontColor('#FFFFFF')
      .onClick(() => {
        void this.handlePrimaryAction();
      });
  }

  @Builder AdvancedToggle() {
    Row() {
      Column({ space: 2 }) {
        Text($r('app.string.connect_advanced_controls'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor('#17181C');

        Text($r('app.string.connect_advanced_controls_desc'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Text(this.advancedOpen ? '▲' : '▼')
        .fontSize(14)
        .fontColor('#4D5563');
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .backgroundColor('#F6F7FA')
    .borderRadius(14)
    .border({ width: 1, color: '#E5E7EC' })
    .onClick(() => {
      this.advancedOpen = !this.advancedOpen;
    });
  }

  @Builder AdvancedControlsCard() {
    Column({ space: 12 }) {
      Text($r('app.string.connect_connection_method'))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');

      Row() {
        this.MethodChip($r('app.string.connect_setup_code'), 'SetupCode', () => {
          this.inputMode = 'SetupCode';
          this.validationText = '';
        });
        this.MethodChip($r('app.string.connect_manual'), 'Manual', () => {
          this.inputMode = 'Manual';
          this.validationText = '';
        });
      }

      Text($r('app.string.connect_run_on_gateway_host'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');

      this.CommandBlock('openclaw qr --setup-code-only');
      this.CommandBlock('openclaw qr --json');

      if (this.inputMode === 'SetupCode') {
        Text($r('app.string.connect_setup_code'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');

        TextArea({ placeholder: $r('app.string.connect_paste_setup_code'), text: this.setupCode })
          .width('100%')
          .height(100)
          .backgroundColor('#F6F7FA')
          .borderColor('#E5E7EC')
          .borderWidth(1)
          .borderRadius(14)
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .fontSize(14)
          .fontColor('#17181C')
          .onChange((value: string) => {
            this.setupCode = value;
            this.validationText = '';
          });

        if (this.setupCodeResolvedEndpoint().length > 0) {
          this.EndpointPreview(this.setupCodeResolvedEndpoint());
        }
      } else {
        Row() {
          this.QuickFillChip($r('app.string.connect_quick_fill_localhost'), () => {
            this.manualHost = '127.0.0.1';
            this.manualPort = '18789';
            this.manualTls = false;
            this.validationText = '';
            void this.viewModel.setManualEnabled(true);
            void this.viewModel.setManualHost(this.manualHost);
            void this.viewModel.setManualPort(18789);
            void this.viewModel.setManualTls(false);
          });
        }

        Text($r('app.string.connect_host'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');
        TextInput({ placeholder: '127.0.0.1', text: this.manualHost })
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
            this.validationText = '';
            void this.viewModel.setManualEnabled(true);
            void this.viewModel.setManualHost(value.trim());
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
            this.validationText = '';
            const parsedPort = parseInt(value.trim(), 10);
            if (!Number.isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
              void this.viewModel.setManualEnabled(true);
              void this.viewModel.setManualPort(parsedPort);
            }
          });

        Row() {
          Column({ space: 2 }) {
            Text($r('app.string.connect_use_tls'))
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor('#17181C');
            Text($r('app.string.connect_use_tls_desc'))
              .fontSize(13)
              .fontWeight(FontWeight.Medium)
              .fontColor('#4D5563');
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1);

          Toggle({ type: ToggleType.Switch, isOn: this.manualTls })
            .selectedColor('#1D5DD8')
            .onChange((isOn: boolean) => {
              this.manualTls = isOn;
              this.validationText = '';
              void this.viewModel.setManualEnabled(true);
              void this.viewModel.setManualTls(isOn);
            });
        }
        .width('100%');

        Text($r('app.string.connect_token_optional'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');
        TextInput({ placeholder: $r('app.string.connect_token_placeholder'), text: this.gatewayToken })
          .width('100%')
          .height(50)
          .backgroundColor('#F6F7FA')
          .borderColor('#E5E7EC')
          .borderWidth(1)
          .borderRadius(14)
          .padding({ left: 12, right: 12 })
          .fontSize(14)
          .fontColor('#17181C')
          .type(InputType.Password)
          .onChange((value: string) => {
            this.gatewayToken = value;
            void this.viewModel.setGatewayToken(value.trim());
          });

        Text($r('app.string.connect_password_optional'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#4D5563');
        TextInput({ placeholder: $r('app.string.connect_password_placeholder'), text: this.gatewayPassword })
          .width('100%')
          .height(50)
          .backgroundColor('#F6F7FA')
          .borderColor('#E5E7EC')
          .borderWidth(1)
          .borderRadius(14)
          .padding({ left: 12, right: 12 })
          .fontSize(14)
          .fontColor('#17181C')
          .type(InputType.Password)
          .onChange((value: string) => {
            this.gatewayPassword = value;
            void this.viewModel.setGatewayPassword(value.trim());
          });

        if (this.manualResolvedEndpoint().length > 0) {
          this.EndpointPreview(this.manualResolvedEndpoint());
        }
      }

      Divider().color('#E5E7EC');

      Text($r('app.string.connect_run_onboarding_again'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#1D5DD8')
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

  @Builder DiscoveredGatewaysCard() {
    Column({ space: 12 }) {
      Text($r('app.string.connect_discovered_gateways'))
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor('#17181C');

      Text(this.viewModel.discoveryStatusText)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#8A92A2');

      if (this.viewModel.gateways.length === 0) {
        Text($r('app.string.connect_no_gateways'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8A92A2');
      } else {
        ForEach(this.viewModel.gateways, (gateway: GatewayEndpoint) => {
          this.GatewayListItem(gateway);
        });
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 14, bottom: 14 })
    .backgroundColor('#FFFFFF')
    .borderRadius(14)
    .border({ width: 1, color: '#E5E7EC' });
  }

  @Builder GatewayListItem(gateway: GatewayEndpoint) {
    Row() {
      Column({ space: 2 }) {
        Text(gateway.name)
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor('#17181C');

        Text(this.formatEndpointForDisplay(gateway.host, gateway.port, gateway.tlsEnabled))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8A92A2');
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Button($r('app.string.connect_action_connect'))
        .height(36)
        .backgroundColor('#1D5DD8')
        .borderRadius(10)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#FFFFFF')
        .onClick(() => {
          this.validationText = '';
          void this.viewModel.connect(gateway);
        });
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 });
  }

  @Builder MethodChip(label: Resource, mode: string, onClick: () => void) {
    Row() {
      Text(label)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.inputMode === mode ? '#FFFFFF' : '#17181C');
    }
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .height(40)
    .padding({ left: 16, right: 16 })
    .borderRadius(12)
    .backgroundColor(this.inputMode === mode ? '#1D5DD8' : '#F6F7FA')
    .border({ width: 1, color: this.inputMode === mode ? '#184DAF' : '#D6DAE2' })
    .margin({ right: 8 })
    .onClick(() => {
      onClick();
    });
  }

  @Builder QuickFillChip(label: Resource, onClick: () => void) {
    Button({ type: ButtonType.Normal }) {
      Text(label)
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1D5DD8');
    }
    .height(32)
    .borderRadius(999)
    .backgroundColor('#ECF3FF')
    .padding({ left: 12, right: 12 })
    .margin({ right: 8 })
    .onClick(() => {
      onClick();
    });
  }

  @Builder CommandBlock(command: string) {
    Row() {
      Row()
        .width(3)
        .height(42)
        .backgroundColor('#3FC97A');

      Text(command)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#E8EAEE')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 });
    }
    .width('100%')
    .backgroundColor('#15171B')
    .borderRadius(12)
    .border({ width: 1, color: '#2B2E35' });
  }

  @Builder EndpointPreview(endpoint: string) {
    Column({ space: 4 }) {
      Text($r('app.string.connect_resolved_endpoint'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor('#4D5563');

      Text(endpoint)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#17181C');
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 });
  }

  private primaryButtonText() {
    if (this.connectedState) {
      return $r('app.string.connect_disconnect_gateway');
    }
    if ((this.statusState || '').toLowerCase().includes('operator offline')) {
      return $r('app.string.connect_reconnect_gateway');
    }
    return $r('app.string.connect_connect_gateway');
  }

  private gatewayStateText() {
    if (this.connectedState) {
      return $r('app.string.chat_connected');
    }
    return this.statusState || $r('app.string.chat_offline');
  }

  private activeEndpointText(): string {
    if (this.connectedState && this.remoteAddressState.length > 0) {
      return this.normalizeEndpointForDisplay(this.remoteAddressState);
    }
    if (this.inputMode === 'SetupCode') {
      const setupResolved = this.setupCodeResolvedEndpoint();
      return setupResolved.length > 0 ? setupResolved : this.localizedText('common_not_set', 'Not set');
    }
    const manualResolved = this.manualResolvedEndpoint();
    return manualResolved.length > 0 ? manualResolved : this.localizedText('common_not_set', 'Not set');
  }

  private setupCodeResolvedEndpoint(): string {
    const code = this.setupCode.trim();
    if (code.length === 0) {
      return '';
    }
    if (code.startsWith('ws://') || code.startsWith('wss://') || code.startsWith('http://') || code.startsWith('https://')) {
      return this.normalizeEndpointForDisplay(code);
    }
    return `openclaw://${code}`;
  }

  private manualResolvedEndpoint(): string {
    const host = this.manualHost.trim();
    const port = this.manualPort.trim();
    if (host.length === 0 || port.length === 0) {
      return '';
    }
    return this.formatEndpointForDisplay(host, port, this.manualTls);
  }

  private formatEndpointForDisplay(host: string, port: number | string, tlsEnabled: boolean): string {
    return `${tlsEnabled ? 'https' : 'http'}://${host}:${port}`;
  }

  private normalizeEndpointForDisplay(endpoint: string): string {
    if (endpoint.startsWith('wss://')) {
      return `https://${endpoint.slice(6)}`;
    }
    if (endpoint.startsWith('ws://')) {
      return `http://${endpoint.slice(5)}`;
    }
    return endpoint;
  }

  private handlePrimaryAction(): void {
    this.validationText = '';

    if (this.connectedState) {
      void MainViewModel.disconnectTask(this.viewModel).then((): void => {
        this.syncConnectionState();
      });
      return;
    }

    if ((this.statusState || '').toLowerCase().includes('operator offline')) {
      void MainViewModel.refreshGatewayConnectionTask(this.viewModel).then((): void => {
        this.syncConnectionState();
      });
      return;
    }

    if (this.inputMode === 'SetupCode') {
      const code = this.setupCode.trim();
      if (code.length === 0) {
        const resource = $r('app.string.connect_validation_setup_code');
        this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
        return;
      }
      void MainViewModel.connectFromSetupCodeTask(this.viewModel, code)
        .then((connected: boolean) => {
          this.syncConnectionState();
          if (!connected) {
            const resource = $r('app.string.connect_validation_setup_code_fail');
            this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
          }
        })
        .catch(() => {
          this.syncConnectionState();
          const resource = $r('app.string.connect_validation_connection_error');
          this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
        });
      return;
    }

    const host = this.manualHost.trim();
    const parsedPort = parseInt(this.manualPort.trim(), 10);
    if (host.length === 0 || Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      const resource = $r('app.string.connect_validation_manual_host_port');
      this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
      return;
    }

    void this.viewModel.setManualEnabled(true)
      .then((): Promise<void> => {
        return this.viewModel.setManualHost(host);
      })
      .then((): Promise<void> => {
        return this.viewModel.setManualPort(parsedPort);
      })
      .then((): Promise<void> => {
        return this.viewModel.setManualTls(this.manualTls);
      })
      .then((): Promise<void> => {
        return this.viewModel.setGatewayToken(this.gatewayToken.trim());
      })
      .then((): Promise<void> => {
        return this.viewModel.setGatewayPassword(this.gatewayPassword.trim());
      })
      .then((): Promise<void> => {
        return MainViewModel.connectManualTask(this.viewModel);
      })
      .then(() => {
        this.syncConnectionState();
        if (!this.viewModel.isConnected) {
          const resource = $r('app.string.connect_validation_connect_failed');
          this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
        }
      })
      .catch(() => {
        this.syncConnectionState();
        const resource = $r('app.string.connect_validation_connection_error');
        this.validationText = getContext(this).resourceManager.getStringSync(resource.id);
      });
  }

  private syncConnectionState(): void {
    this.connectedState = this.viewModel.isConnected;
    this.statusState = this.viewModel.statusText || this.localizedText('chat_offline', 'Offline');
    this.remoteAddressState = this.viewModel.remoteAddress || '';
    this.serverNameState = this.viewModel.serverName || '';
  }

  private localizedText(name: string, fallback: string): string {
    try {
      void this.localeVersion;
      return getContext(this).resourceManager.getStringByNameSync(name);
    } catch (error) {
      console.warn('ConnectPage: localizedText failed for key: ' + name);
      return fallback;
    }
  }
}