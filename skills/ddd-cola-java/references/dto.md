# DTO Templates

## Response Base Classes

```java
// Response - Unified response format
public class Response extends DTO {
    private boolean success;
    private String errCode;
    private String errMessage;
    
    public static Response buildSuccess() {
        Response response = new Response();
        response.setSuccess(true);
        return response;
    }
    
    public static Response buildFailure(String errCode, String errMessage) {
        Response response = new Response();
        response.setSuccess(false);
        response.setErrCode(errCode);
        response.setErrMessage(errMessage);
        return response;
    }
}

// SingleResponse - Single object response
public class SingleResponse<T> extends Response {
    private T data;
    
    public static <T> SingleResponse<T> of(T data) {
        SingleResponse<T> response = new SingleResponse<>();
        response.setSuccess(true);
        response.setData(data);
        return response;
    }
}

// MultiResponse - Multiple objects response
public class MultiResponse<T> extends Response {
    private Collection<T> data;
    
    public static <T> MultiResponse<T> of(Collection<T> data) {
        MultiResponse<T> response = new MultiResponse<>();
        response.setSuccess(true);
        response.setData(data);
        return response;
    }
}

// PageResponse - Paginated response
public class PageResponse<T> extends Response {
    private int totalCount;
    private int pageSize;
    private int pageIndex;
    private Collection<T> data;
}
```

## Command

```java
// client/dto/command/UserAddCmd.java
public class UserAddCmd extends Command {
    private UserCO userCO;
    
    public UserCO getUserCO() { return userCO; }
    public void setUserCO(UserCO userCO) { this.userCO = userCO; }
}
```

## Query

```java
// client/dto/query/UserListQry.java
public class UserListQry extends Query {
    private String keyword;
    private int pageIndex = 1;
    private int pageSize = 10;
    
    // getters and setters
}
```

## Client Object (CO)

```java
// client/dto/clientobject/UserCO.java
@Data
public class UserCO extends DTO {
    private Long id;
    private String name;
    private String email;
    private String status;
}
```

## Maven Dependency

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-dto</artifactId>
</dependency>
```
