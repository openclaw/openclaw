# COLA Components Guide

## Components Overview

| Component | Maven ArtifactId | Function |
|-----------|------------------|----------|
| DTO Component | `cola-component-dto` | Response, Command, Query, PageResponse |
| Exception Component | `cola-component-exception` | BizException, SysException, ErrorCode |
| CatchLog Component | `cola-component-catchlog-starter` | @CatchAndLog exception catching and logging |
| Extension Component | `cola-component-extension-starter` | Extension point mechanism |
| StateMachine Component | `cola-component-statemachine` | State machine |
| Domain Component | `cola-component-domain-starter` | Spring-managed domain entities |
| RuleEngine Component | `cola-component-ruleengine` | Rule engine |
| Test Component | `cola-component-test-container` | Test container |

---

## 1. DTO Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-dto</artifactId>
</dependency>
```

### Response Types

```java
// Basic response
Response.buildSuccess();
Response.buildFailure("ERROR_CODE", "Error message");

// Single object response
SingleResponse<UserCO> response = SingleResponse.of(userCO);

// Multiple objects response
MultiResponse<UserCO> response = MultiResponse.of(userList);

// Paginated response
PageResponse<UserCO> response = PageResponse.of(userList, totalCount, pageSize, pageIndex);
```

### Command 和 Query

```java
// Write operation - extends Command
public class UserAddCmd extends Command {
    private UserCO userCO;
}

// Read operation - extends Query
public class UserListQry extends Query {
    private String keyword;
}

// Paginated query - extends PageQuery
public class UserPageQry extends PageQuery {
    private String status;
}
```

---

## 2. Exception Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-exception</artifactId>
</dependency>
```

### Exception Types

```java
// Business exception - User-understandable errors
throw new BizException("USER_NOT_FOUND", "User not found");

// System exception - Technical errors
throw new SysException("DB_ERROR", "Database connection failed");
```

### Error Code Interface

```java
public enum ErrorCode implements ErrorCodeI {
    USER_NOT_FOUND("USER_NOT_FOUND", "User not found"),
    EMAIL_EXISTS("EMAIL_EXISTS", "Email already exists"),
    PARAM_ERROR("PARAM_ERROR", "Parameter error");
    
    private String errCode;
    private String errDesc;
    
    @Override
    public String getErrCode() { return errCode; }
    
    @Override
    public String getErrDesc() { return errDesc; }
}

// Usage
throw new BizException(ErrorCode.USER_NOT_FOUND);
```

---

## 3. CatchLog Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-catchlog-starter</artifactId>
</dependency>
```

### @CatchAndLog Annotation

```java
@Service
@CatchAndLog  // Automatically catch exceptions and log
public class UserServiceImpl implements UserServiceI {
    
    @Override
    public Response addUser(UserAddCmd cmd) {
        // BizException → Response.buildFailure()
        // Other exceptions → Log + System error response
        return userAddCmdExe.execute(cmd);
    }
}
```

---

## 4. Extension Point Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-extension-starter</artifactId>
</dependency>
```

### Define Extension Point

```java
// Extension point interface
public interface OrderExtPt extends ExtensionPointI {
    void beforeCreate(Order order);
    void afterCreate(Order order);
    BigDecimal calculateDiscount(Order order);
}
```

### Implement Extension Point

```java
// Normal order extension
@Extension(bizId = "normalOrder")
public class NormalOrderExt implements OrderExtPt {
    @Override
    public void beforeCreate(Order order) {
        // Normal order logic
    }
    
    @Override
    public BigDecimal calculateDiscount(Order order) {
        return BigDecimal.ZERO;
    }
}

// VIP order extension
@Extension(bizId = "vipOrder")
public class VipOrderExt implements OrderExtPt {
    @Override
    public void beforeCreate(Order order) {
        // VIP order logic
    }
    
    @Override
    public BigDecimal calculateDiscount(Order order) {
        return order.getAmount().multiply(new BigDecimal("0.1")); // 10% discount
    }
}
```

### Use Extension Point

```java
@Service
public class OrderServiceImpl {
    
    @Autowired
    private ExtensionExecutor extensionExecutor;
    
    public void createOrder(Order order, String bizId) {
        // Execute extension point (no return value)
        extensionExecutor.executeVoid(
            OrderExtPt.class, 
            BizScenario.valueOf(bizId),
            ext -> ext.beforeCreate(order)
        );
        
        // Execute extension point (with return value)
        BigDecimal discount = extensionExecutor.execute(
            OrderExtPt.class,
            BizScenario.valueOf(bizId),
            ext -> ext.calculateDiscount(order)
        );
        
        order.setDiscount(discount);
        orderRepository.save(order);
    }
}
```

### BizScenario Business Scenario

```java
// Single dimension
BizScenario.valueOf("vipOrder");

// Two dimensions: bizId + useCase
BizScenario.valueOf("vipOrder", "create");

// Three dimensions: bizId + useCase + scenario
BizScenario.valueOf("vipOrder", "create", "promotion");
```

---

## 5. StateMachine Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-statemachine</artifactId>
</dependency>
```

### Define States and Events

```java
// State enum
public enum OrderState {
    INIT, PAID, SHIPPED, RECEIVED, CANCELLED
}

// Event enum
public enum OrderEvent {
    PAY, SHIP, RECEIVE, CANCEL
}
```

### Build State Machine

```java
@Configuration
public class OrderStateMachineConfig {
    
    @Bean
    public StateMachine<OrderState, OrderEvent, Order> orderStateMachine() {
        StateMachineBuilder<OrderState, OrderEvent, Order> builder = 
            StateMachineBuilderFactory.create();
        
        // INIT -> PAID (on PAY)
        builder.externalTransition()
            .from(OrderState.INIT)
            .to(OrderState.PAID)
            .on(OrderEvent.PAY)
            .when(this::checkPayCondition)
            .perform(this::doPayAction);
        
        // PAID -> SHIPPED (on SHIP)
        builder.externalTransition()
            .from(OrderState.PAID)
            .to(OrderState.SHIPPED)
            .on(OrderEvent.SHIP)
            .perform(this::doShipAction);
        
        // SHIPPED -> RECEIVED (on RECEIVE)
        builder.externalTransition()
            .from(OrderState.SHIPPED)
            .to(OrderState.RECEIVED)
            .on(OrderEvent.RECEIVE)
            .perform(this::doReceiveAction);
        
        // Any state -> CANCELLED (on CANCEL)
        builder.externalTransitions()
            .fromAmong(OrderState.INIT, OrderState.PAID)
            .to(OrderState.CANCELLED)
            .on(OrderEvent.CANCEL)
            .perform(this::doCancelAction);
        
        return builder.build("orderStateMachine");
    }
    
    private boolean checkPayCondition(Order order) {
        return order.getAmount().compareTo(BigDecimal.ZERO) > 0;
    }
    
    private void doPayAction(OrderState from, OrderState to, OrderEvent event, Order order) {
        order.setPaidTime(LocalDateTime.now());
        log.info("Order {} paid", order.getId());
    }
}
```

### Use State Machine

```java
@Service
public class OrderServiceImpl {
    
    @Autowired
    private StateMachine<OrderState, OrderEvent, Order> orderStateMachine;
    
    public void payOrder(Order order) {
        // Trigger state transition
        OrderState newState = orderStateMachine.fireEvent(
            order.getState(),  // Current state
            OrderEvent.PAY,    // Event
            order              // Context
        );
        
        order.setState(newState);
        orderRepository.save(order);
    }
}
```

### Internal Transition (State Unchanged)

```java
// Internal transition: state unchanged, but action executed
builder.internalTransition()
    .within(OrderState.PAID)
    .on(OrderEvent.UPDATE_ADDRESS)
    .perform(this::doUpdateAddress);
```

---

## 6. Domain Component

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-domain-starter</artifactId>
</dependency>
```

### Spring-Managed Domain Entities

```java
@Configuration
@EnableDomainEntity
public class DomainConfig {
}

// Domain entities can inject Spring Beans
@Entity
public class Order {
    
    @Autowired
    private OrderRepository orderRepository;
    
    @Autowired
    private EventPublisher eventPublisher;
    
    public void save() {
        orderRepository.save(this);
        eventPublisher.publish(new OrderCreatedEvent(this));
    }
}
```

---

## 7. Maven BOM

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

---

## Component Selection Guide

| Scenario | Recommended Components |
|----------|------------------------|
| Basic project | dto + exception + catchlog |
| Multi-business lines | + extension |
| Complex state flow | + statemachine |
| Domain-driven design | + domain |
