# Complete Example: User Management Module

## Controller (Adapter Layer)

```java
// adapter/web/UserController.java
@RestController
@RequestMapping("/api/users")
public class UserController {
    
    @Autowired
    private UserServiceI userService;
    
    @PostMapping
    public Response addUser(@RequestBody UserAddCmd cmd) {
        return userService.addUser(cmd);
    }
    
    @GetMapping
    public MultiResponse<UserCO> listUsers(UserListQry qry) {
        return userService.listUsers(qry);
    }
    
    @GetMapping("/{id}")
    public SingleResponse<UserCO> getUser(@PathVariable Long id) {
        UserGetQry qry = new UserGetQry();
        qry.setUserId(id);
        return userService.getUser(qry);
    }
}
```

## Maven Module Dependencies

```xml
<!-- Parent POM -->
<modules>
    <module>project-adapter</module>
    <module>project-app</module>
    <module>project-client</module>
    <module>project-domain</module>
    <module>project-infrastructure</module>
    <module>start</module>
</modules>

<!-- project-adapter -->
<dependencies>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-app</artifactId>
    </dependency>
</dependencies>

<!-- project-app -->
<dependencies>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-domain</artifactId>
    </dependency>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-client</artifactId>
    </dependency>
    <dependency>
        <groupId>com.alibaba.cola</groupId>
        <artifactId>cola-component-catchlog-starter</artifactId>
    </dependency>
</dependencies>

<!-- project-domain -->
<dependencies>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-client</artifactId>
    </dependency>
</dependencies>

<!-- project-infrastructure -->
<dependencies>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-domain</artifactId>
    </dependency>
</dependencies>

<!-- start -->
<dependencies>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-adapter</artifactId>
    </dependency>
    <dependency>
        <groupId>com.company</groupId>
        <artifactId>project-infrastructure</artifactId>
    </dependency>
</dependencies>
```

## COLA BOM

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>com.alibaba.cola</groupId>
            <artifactId>cola-components-bom</artifactId>
            <version>5.0.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>
```

## Exception Handling

```java
// Business exception
throw new BizException("USER_NOT_FOUND", "User not found");

// System exception
throw new SysException("DATABASE_ERROR", "Database connection failed");

// Using error code enum
public enum ErrorCode implements ErrorCodeI {
    USER_NOT_FOUND("USER_NOT_FOUND", "User not found"),
    EMAIL_EXISTS("EMAIL_EXISTS", "Email already exists");
    
    private String errCode;
    private String errDesc;
}
```

## State Machine

```java
StateMachineBuilder<OrderState, OrderEvent, Order> builder = 
    StateMachineBuilderFactory.create();

builder.externalTransition()
    .from(OrderState.CREATED)
    .to(OrderState.PAID)
    .on(OrderEvent.PAY)
    .when(checkCondition())
    .perform(doAction());

StateMachine<OrderState, OrderEvent, Order> stateMachine = 
    builder.build("orderStateMachine");

// Trigger state transition
stateMachine.fireEvent(OrderState.CREATED, OrderEvent.PAY, order);
```

## Extension Points

```java
// Define extension point interface
public interface OrderExtPt extends ExtensionPointI {
    void beforeCreate(Order order);
}

// Implement extension point
@Extension(bizId = "vip", useCase = "order")
public class VipOrderExt implements OrderExtPt {
    @Override
    public void beforeCreate(Order order) {
        order.applyVipDiscount();
    }
}

// Use extension point
@Autowired
private ExtensionExecutor extensionExecutor;

extensionExecutor.executeVoid(OrderExtPt.class, 
    BizScenario.valueOf("vip", "order"), 
    ext -> ext.beforeCreate(order));
```
